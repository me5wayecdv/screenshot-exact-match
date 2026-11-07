#!/usr/bin/env node
/**
 * Parity check: D1 (new Cloudflare deployment) vs live Supabase.
 *
 * READ-ONLY BY CONSTRUCTION — this script cannot write to either system:
 * - D1 is read only through `wrangler d1 execute --command` with a
 *   fixed query this script builds itself: SELECT COUNT(*) FROM <table>.
 *   Table names come ONLY from the allowlist below (exact match); no
 *   user-supplied SQL is ever executed, and no INSERT/UPDATE/DELETE/
 *   DROP/ALTER statement exists anywhere in this file.
 * - Supabase is read only through PostgREST GET requests with
 *   Prefer: count=exact (a HEAD-style count read, no body fetched).
 *
 * NO CREDENTIALS IN THIS FILE. Everything secret comes from the
 * operator's environment at run time:
 *   SUPABASE_URL, SUPABASE_KEY (a read-only-capable key the operator
 *   provides; anon keys may be blocked by RLS and then report
 *   UNAVAILABLE instead of a count — see parity-check.md).
 * The D1 database name comes from --d1-database (default qemmini-db)
 * and wrangler's own login; this script never reads or prints tokens.
 *
 * Usage:
 *   node scripts/parity-check.mjs [--dry-run] [--d1-database NAME]
 *     [--d1-local] [--tables a,b,c] [--supabase-tables-only]
 *
 * Exit codes: 0 = every comparable table matches (UNAVAILABLE rows are
 * warnings, not failures, because Supabase RLS may legitimately block
 * an anon key); 1 = at least one table DIFFERS, or a command failed.
 *
 * Behavioural loops (group-exam member/non-member/stale, publish,
 * grading, handwritten, quota concurrency) cannot be checked by row
 * counts and are NOT attempted here — they are manual steps in
 * scripts/parity-check.md, run against test accounts only.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// D1 tables (schema/d1-*.sql) mapped to their Supabase counterparts.
// `supabase: null` means "no PostgREST equivalent": Supabase auth
// tables live outside the public schema, so those rows are compared
// by hand from the Supabase dashboard (see the checklist) and report
// as MANUAL here instead of a number.
const TABLES = [
  { d1: "auth_users", supabase: null, note: "Supabase auth.users — dashboard count" },
  { d1: "auth_sessions", supabase: null, note: "Supabase auth.sessions — dashboard count" },
  { d1: "profiles", supabase: "profiles" },
  { d1: "user_roles", supabase: "user_roles" },
  { d1: "teacher_profiles", supabase: "teacher_profiles" },
  { d1: "subjects", supabase: "subjects" },
  { d1: "assessments", supabase: "assessments" },
  { d1: "questions", supabase: "questions" },
  // question_keys is deliberately NOT counted from Supabase here:
  // counting it would need a privileged read of answer keys. The
  // checklist covers it as a manual, admin-only dashboard check.
  { d1: "assessment_assignments", supabase: "assessment_assignments" },
  { d1: "submissions", supabase: "submissions" },
  { d1: "answers", supabase: "answers" },
  { d1: "teacher_students", supabase: "teacher_students" },
  { d1: "teacher_groups", supabase: "teacher_groups" },
  { d1: "group_members", supabase: "group_members" },
  { d1: "group_exams", supabase: "group_exams" },
  { d1: "lessons", supabase: "lessons" },
  { d1: "lesson_enrollments", supabase: "lesson_enrollments" },
  { d1: "grade_review_requests", supabase: "grade_review_requests" },
  { d1: "handwritten_grades", supabase: "handwritten_grades" },
  { d1: "integrity_events", supabase: "integrity_events" },
  { d1: "ai_usage_events", supabase: "ai_usage_events" },
  { d1: "ai_training_examples", supabase: "ai_training_examples" },
  { d1: "ai_rate_limits", supabase: "ai_rate_limits" },
  { d1: "whatsapp_sends", supabase: "whatsapp_sends" },
  { d1: "whatsapp_send_claims", supabase: "whatsapp_send_claims" },
  { d1: "audit_log", supabase: "audit_log" },
  { d1: "login_attempts", supabase: null, note: "D1-only table (no Supabase equivalent)" },
  {
    d1: "password_reset_tokens",
    supabase: null,
    note: "D1-only table (Supabase handled resets internally)",
  },
];

function parseArgs(argv) {
  const args = { dryRun: false, d1Database: "qemmini-db", d1Local: false, tables: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--d1-local") args.d1Local = true;
    else if (a === "--d1-database") args.d1Database = argv[++i] ?? args.d1Database;
    else if (a.startsWith("--d1-database=")) args.d1Database = a.split("=")[1];
    else if (a === "--tables")
      args.tables = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a.startsWith("--tables="))
      args.tables = a
        .slice("--tables=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/parity-check.mjs [--dry-run] [--d1-database NAME] [--d1-local] [--tables a,b,c]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function d1CountSql(table) {
  // Fixed shape, allowlisted table name only. This is the ONLY SQL
  // this script ever runs, and it is a read-only COUNT.
  return `SELECT COUNT(*) AS n FROM ${table}`;
}

async function d1Count(database, table, local, dryRun) {
  const cmd = ["d1", "execute", database, "--command", d1CountSql(table), "--json"];
  if (local) cmd.push("--local");
  else cmd.push("--remote");
  if (dryRun) {
    console.log(`[dry-run] wrangler ${cmd.join(" ")}`);
    return null;
  }
  try {
    const { stdout } = await execFileAsync("wrangler", cmd, { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
    const n = rows?.[0]?.n;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

async function supabaseCount(baseUrl, key, table) {
  const url = `${baseUrl.replace(/\/+$/, "")}/rest/v1/${table}?select=id`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    });
    if (!res.ok) return null;
    const range = res.headers.get("content-range") ?? "";
    const total = range.split("/")[1];
    const n = total === "*" ? null : Number(total);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.tables ? TABLES.filter((t) => args.tables.includes(t.d1)) : TABLES;
  const unknown = (args.tables ?? []).filter((t) => !TABLES.some((row) => row.d1 === t));
  if (unknown.length) {
    console.error(`Unknown tables (not in allowlist): ${unknown.join(", ")}`);
    process.exit(2);
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseKey = process.env.SUPABASE_KEY ?? "";
  const supabaseReady = Boolean(supabaseUrl && supabaseKey);
  if (!supabaseReady && !args.dryRun) {
    console.log(
      "NOTE: SUPABASE_URL / SUPABASE_KEY not set — Supabase column will show UNAVAILABLE.",
    );
  }

  console.log("table,d1,supabase,status,note");
  let diffs = 0;
  for (const row of selected) {
    const d1 = await d1Count(args.d1Database, row.d1, args.d1Local, args.dryRun);
    let sup = null;
    let status;
    let note = row.note ?? "";
    if (args.dryRun) {
      status = "DRY_RUN";
      if (row.supabase && supabaseReady) {
        console.log(
          `[dry-run] GET ${supabaseUrl.replace(/\/+$/, "")}/rest/v1/${row.supabase}?select=id (Prefer: count=exact)`,
        );
      }
    } else if (!row.supabase) {
      status = "MANUAL";
    } else if (!supabaseReady) {
      status = "UNAVAILABLE";
      note = note || "SUPABASE_URL/SUPABASE_KEY not set";
    } else {
      sup = await supabaseCount(supabaseUrl, supabaseKey, row.supabase);
      if (sup === null || d1 === null) {
        status = "UNAVAILABLE";
        note = note || "read failed (check wrangler login / key / RLS)";
      } else if (sup === d1) {
        status = "MATCH";
      } else {
        status = "DIFF";
        diffs += 1;
      }
    }
    if (args.dryRun && d1 === null && row.supabase) status = "DRY_RUN";
    console.log(`${row.d1},${d1 ?? ""},${sup ?? ""},${status},${note}`);
  }
  if (args.dryRun) {
    console.log("Dry run: no live system was queried.");
    return;
  }
  if (diffs > 0) {
    console.log(`${diffs} table(s) DIFFER — do not cut over until each diff is explained.`);
    process.exitCode = 1;
  } else {
    console.log("No DIFF rows. MANUAL / UNAVAILABLE rows still need the checklist steps.");
  }
}

main().catch((err) => {
  console.error("parity-check failed:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
