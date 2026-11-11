#!/usr/bin/env node
/**
 * Purge ALL test accounts from the LIVE Qemmini database + their R2 objects.
 *
 * Scope (decided by the user 2026-11-11, to leave room for real people):
 *   DELETE every auth_users row whose email ends in @example.com, EXCEPT
 *   the live admin account — plus every row that belongs to those users
 *   (profiles, roles, groups, exams, submissions, answers, R2 objects…).
 *   KEEP: the live admin (qemmini-live-admin-20261104@example.com) and
 *   every non-@example.com account (3 real Gmail signups as of 2026-11-11).
 *
 * Safety:
 *   - Without --confirm this prints the plan and touches nothing.
 *   - Guards run BEFORE any delete and abort the run if the situation
 *     changed since the plan was written: the real-user count must still
 *     be exactly EXPECTED_REAL_USERS, and the admin account must exist.
 *     (A new real signup must never be caught by a stale assumption.)
 *   - Deletes run children-first, parents-last, so they are FK-safe even
 *     with foreign-key enforcement on (D1 enforces FKs per connection;
 *     the order is what makes this safe, not a pragma).
 *   - R2 objects are deleted BEFORE the D1 rows: an R2 failure aborts
 *     the run with the database untouched. R2 keys are <user_id>/… so
 *     only objects whose first path segment is a test user id are removed.
 *   - ai_training_examples rows are NOT deleted: they carry no user FK
 *     and their fate is a retention-policy decision (see
 *     docs/retention-policy.md), not part of this purge.
 *   - Run a fresh backup (drill=true) BEFORE this script, every time.
 *     The backup artifact is the only way back.
 *
 * Binding rule (same as scripts/backup-d1.mjs): the root wrangler.jsonc
 * is the authority. For --env live it must already be rebound to
 * qemmini-live-db. Never pass --config wrangler-live.jsonc.
 *
 * Required env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (D1 + R2).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./backup-d1.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DATABASE_ID = "3d9fae1b-acb7-426c-a7ec-307217fab151";
const ADMIN_EMAIL = "qemmini-live-admin-20261104@example.com";
const EXPECTED_REAL_USERS = 3;
const BUCKETS = ["qemmini-handwritten-papers", "qemmini-generation-sources"];

const WRANGLER = join(appRoot, "node_modules", "wrangler", "bin", "wrangler.js");

// The test-user set: every @example.com account except the live admin.
export const TEST_USERS = `(SELECT id FROM auth_users WHERE email LIKE '%@example.com' AND email <> '${ADMIN_EMAIL}')`;
const TEST_ASSESSMENTS = `(SELECT id FROM assessments WHERE teacher_id IN ${TEST_USERS})`;
const TEST_QUESTIONS = `(SELECT id FROM questions WHERE assessment_id IN ${TEST_ASSESSMENTS})`;
const TEST_SUBMISSIONS = `(SELECT id FROM submissions WHERE student_id IN ${TEST_USERS} OR assessment_id IN ${TEST_ASSESSMENTS})`;
const TEST_GROUPS = `(SELECT id FROM teacher_groups WHERE teacher_id IN ${TEST_USERS})`;
const TEST_LESSONS = `(SELECT id FROM lessons WHERE tutor_id IN ${TEST_USERS})`;

// Children first, parents last. Each entry is [table, DELETE statement].
export const DELETES = [
  ["answers", `DELETE FROM answers WHERE submission_id IN ${TEST_SUBMISSIONS}`],
  [
    "grade_review_requests",
    `DELETE FROM grade_review_requests WHERE submission_id IN ${TEST_SUBMISSIONS}`,
  ],
  ["integrity_events", `DELETE FROM integrity_events WHERE submission_id IN ${TEST_SUBMISSIONS}`],
  ["whatsapp_sends", `DELETE FROM whatsapp_sends WHERE submission_id IN ${TEST_SUBMISSIONS}`],
  [
    "whatsapp_send_claims",
    `DELETE FROM whatsapp_send_claims WHERE submission_id IN ${TEST_SUBMISSIONS}`,
  ],
  [
    "submissions",
    `DELETE FROM submissions WHERE student_id IN ${TEST_USERS} OR assessment_id IN ${TEST_ASSESSMENTS}`,
  ],
  ["take_write_failures", `DELETE FROM take_write_failures WHERE student_id IN ${TEST_USERS}`],
  [
    "assessment_assignments",
    `DELETE FROM assessment_assignments WHERE student_id IN ${TEST_USERS} OR assessment_id IN ${TEST_ASSESSMENTS}`,
  ],
  ["group_exams", `DELETE FROM group_exams WHERE assessment_id IN ${TEST_ASSESSMENTS}`],
  ["question_keys", `DELETE FROM question_keys WHERE question_id IN ${TEST_QUESTIONS}`],
  ["questions", `DELETE FROM questions WHERE assessment_id IN ${TEST_ASSESSMENTS}`],
  ["assessments", `DELETE FROM assessments WHERE teacher_id IN ${TEST_USERS}`],
  [
    "group_members",
    `DELETE FROM group_members WHERE student_id IN ${TEST_USERS} OR group_id IN ${TEST_GROUPS}`,
  ],
  [
    "lesson_enrollments",
    `DELETE FROM lesson_enrollments WHERE student_id IN ${TEST_USERS} OR lesson_id IN ${TEST_LESSONS}`,
  ],
  ["lessons", `DELETE FROM lessons WHERE tutor_id IN ${TEST_USERS}`],
  ["teacher_groups", `DELETE FROM teacher_groups WHERE teacher_id IN ${TEST_USERS}`],
  [
    "teacher_students",
    `DELETE FROM teacher_students WHERE teacher_id IN ${TEST_USERS} OR student_id IN ${TEST_USERS}`,
  ],
  ["subjects", `DELETE FROM subjects WHERE teacher_id IN ${TEST_USERS}`],
  [
    "handwritten_grades",
    `DELETE FROM handwritten_grades WHERE teacher_id IN ${TEST_USERS} OR student_id IN ${TEST_USERS}`,
  ],
  ["ai_usage_events", `DELETE FROM ai_usage_events WHERE teacher_id IN ${TEST_USERS}`],
  ["ai_rate_limits", `DELETE FROM ai_rate_limits WHERE user_id IN ${TEST_USERS}`],
  ["audit_log", `DELETE FROM audit_log WHERE actor_id IN ${TEST_USERS}`],
  ["auth_sessions", `DELETE FROM auth_sessions WHERE user_id IN ${TEST_USERS}`],
  [
    "login_attempts",
    `DELETE FROM login_attempts WHERE email LIKE '%@example.com' AND email <> '${ADMIN_EMAIL}'`,
  ],
  ["password_reset_tokens", `DELETE FROM password_reset_tokens WHERE user_id IN ${TEST_USERS}`],
  ["user_roles", `DELETE FROM user_roles WHERE user_id IN ${TEST_USERS}`],
  ["teacher_profiles", `DELETE FROM teacher_profiles WHERE user_id IN ${TEST_USERS}`],
  ["profiles", `DELETE FROM profiles WHERE id IN ${TEST_USERS}`],
  ["auth_users", `DELETE FROM auth_users WHERE id IN ${TEST_USERS}`],
];

const COUNTS_SQL =
  `SELECT (SELECT COUNT(*) FROM auth_users) AS users_total, ` +
  `(SELECT COUNT(*) FROM auth_users WHERE email LIKE '%@example.com' AND email <> '${ADMIN_EMAIL}') AS test_users, ` +
  `(SELECT COUNT(*) FROM auth_users WHERE email NOT LIKE '%@example.com') AS real_users, ` +
  `(SELECT COUNT(*) FROM auth_users WHERE email = '${ADMIN_EMAIL}') AS admin_present, ` +
  `(SELECT COUNT(*) FROM submissions) AS submissions, ` +
  `(SELECT COUNT(*) FROM assessments) AS assessments, ` +
  `(SELECT COUNT(*) FROM answers) AS answers, ` +
  `(SELECT COUNT(*) FROM profiles) AS profiles`;

function wrangler(args, { json = false } = {}) {
  // execFileSync's default error hides the child's output — surface it,
  // otherwise a failed D1 call is undiagnosable (as the first purge run
  // proved: exit 1 with no cause). Never print the full command line:
  // it can contain the database id.
  try {
    const out = execFileSync(process.execPath, [WRANGLER, ...args], {
      cwd: appRoot,
      encoding: "utf8",
      stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    });
    return json ? JSON.parse(out) : out;
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`wrangler ${args[0]} ${args[1]} failed: ${detail || error.message}`);
  }
}

function d1Query(database, sql) {
  const out = wrangler(["d1", "execute", database, "--remote", "--command", sql, "--json"], {
    json: true,
  });
  const row = out?.[0]?.results?.[0];
  if (!row) throw new Error(`Unexpected D1 response for query: ${sql.slice(0, 80)}`);
  return row;
}

function checkBinding(env) {
  const config = parseJsonc(readFileSync(join(appRoot, "wrangler.jsonc"), "utf8"));
  const db = config.d1_databases?.find((entry) => entry.binding === "DB");
  if (!db) throw new Error("wrangler.jsonc has no DB binding.");
  if (env === "live" && db.database_name !== "qemmini-live-db") {
    throw new Error(
      `wrangler.jsonc is bound to "${db.database_name}", not "qemmini-live-db". ` +
        `Rebind first: database_name "qemmini-live-db" AND database_id "${LIVE_DATABASE_ID}". ` +
        "Never use --config wrangler-live.jsonc.",
    );
  }
  return db.database_name;
}

async function listBucketKeys(accountId, apiToken, bucket) {
  const keys = [];
  let cursor;
  do {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`,
    );
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` } });
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(`Listing ${bucket} failed: ${JSON.stringify(body.errors ?? body)}`);
    }
    for (const object of body.result ?? []) keys.push(object.key);
    cursor = body.result_info?.cursor;
  } while (cursor);
  return keys;
}

function argOf(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(
      [
        "Usage: node scripts/purge-test-accounts.mjs --env live [--confirm]",
        "",
        "Deletes EVERY @example.com test account (except the live admin) from",
        "the LIVE database and their R2 objects. Keeps the admin and all",
        "non-@example.com (real) accounts.",
        "",
        "Without --confirm this prints the plan and touches nothing.",
        "With --confirm it deletes, then verifies the post-purge counts.",
        "",
        "Run a fresh backup (drill=true) BEFORE this script, every time.",
      ].join("\n"),
    );
    return 0;
  }

  const env = argOf(argv, "--env");
  if (env !== "live") {
    console.error("ERROR: this script only runs with --env live. Test data lives in live.");
    return 2;
  }
  const confirm = argv.includes("--confirm");

  let database;
  try {
    database = checkBinding(env);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }

  if (!confirm) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          database,
          deletes: DELETES.map(([table]) => table),
          keeps: { admin: ADMIN_EMAIL, realUsersExpected: EXPECTED_REAL_USERS },
          buckets: BUCKETS,
          note: "Run a fresh backup (drill=true) first. Pass --confirm to execute.",
        },
        null,
        2,
      ),
    );
    console.error("\nDry run only. Nothing was read or written. Pass --confirm to execute.");
    return 0;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error("ERROR: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
    return 3;
  }

  // ---- Guards: abort if the situation changed since the plan was written.
  const before = d1Query(database, COUNTS_SQL);
  console.log("Before:", JSON.stringify(before));
  if (before.real_users !== EXPECTED_REAL_USERS) {
    console.error(
      `ERROR: real (non-@example.com) users = ${before.real_users}, expected ${EXPECTED_REAL_USERS}. ` +
        "The situation changed — refusing to purge on a stale assumption. Re-check and update EXPECTED_REAL_USERS.",
    );
    return 4;
  }
  if (before.admin_present !== 1) {
    console.error("ERROR: live admin account not found. Refusing to purge.");
    return 4;
  }
  if (before.test_users === 0) {
    console.log("Already clean: no test users. Nothing to delete.");
    return 0;
  }

  // ---- R2 first: an R2 failure aborts with the database untouched.
  // Fetch the full test-user id list (d1Query returns a single row only,
  // so the id list goes through a raw JSON query).
  const idsOut = wrangler(
    [
      "d1",
      "execute",
      database,
      "--remote",
      "--command",
      `SELECT id FROM auth_users WHERE email LIKE '%@example.com' AND email <> '${ADMIN_EMAIL}'`,
      "--json",
    ],
    { json: true },
  );
  const ids = (idsOut?.[0]?.results ?? []).map((r) => r.id);
  const idSet = new Set(ids);
  if (ids.length !== before.test_users) {
    console.error(
      `ERROR: fetched ${ids.length} test ids but pre-counts said ${before.test_users}. Aborting.`,
    );
    return 4;
  }

  let r2Deleted = 0;
  for (const bucket of BUCKETS) {
    const keys = await listBucketKeys(accountId, apiToken, bucket);
    const owned = keys.filter((key) => idSet.has(key.split("/")[0]));
    console.log(`${bucket}: ${keys.length} objects listed, ${owned.length} owned by test users.`);
    for (const key of owned) {
      try {
        wrangler(["r2", "object", "delete", `${bucket}/${key}`, "--remote"]);
      } catch {
        console.error(`ERROR: could not delete ${bucket}/${key}. Aborting before any D1 delete.`);
        return 5;
      }
      r2Deleted += 1;
    }
  }
  console.log(`R2 cleanup done: ${r2Deleted} test-owned objects deleted.`);

  // ---- D1 deletes, children first.
  const dir = join(tmpdir(), `qemmini-purge-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const sqlPath = join(dir, "purge.sql");
  writeFileSync(
    sqlPath,
    [
      "PRAGMA foreign_keys = ON;",
      "-- Deletes are ordered children-first; the pragma is belt-and-braces,",
      "-- the order is what makes this safe under enforcement.",
      ...DELETES.map(([, sql]) => `${sql};`),
    ].join("\n"),
  );
  try {
    wrangler(["d1", "execute", database, "--remote", "--file", sqlPath, "--yes"]);
  } catch {
    console.error("ERROR: D1 purge failed partway. Check the counts below and the backup.");
    return 6;
  }

  // ---- Verify the post-purge state.
  const after = d1Query(database, COUNTS_SQL);
  console.log("After:", JSON.stringify(after));
  const problems = [];
  if (after.test_users !== 0) problems.push(`test_users=${after.test_users}, expected 0`);
  if (after.users_total !== EXPECTED_REAL_USERS + 1) {
    problems.push(
      `users_total=${after.users_total}, expected ${EXPECTED_REAL_USERS + 1} (admin + real)`,
    );
  }
  if (after.submissions !== 0) problems.push(`submissions=${after.submissions}, expected 0`);
  if (after.assessments !== 0) problems.push(`assessments=${after.assessments}, expected 0`);
  if (after.answers !== 0) problems.push(`answers=${after.answers}, expected 0`);
  if (problems.length > 0) {
    console.error(
      `ERROR: post-purge verification FAILED: ${problems.join("; ")}. Restore from the backup.`,
    );
    return 7;
  }
  console.log(
    `Purge complete: ${before.test_users} test users deleted ` +
      `(${before.submissions} submissions, ${before.assessments} assessments, ${before.answers} answers), ` +
      `${r2Deleted} R2 objects deleted. Kept: admin + ${after.real_users} real users.`,
  );
  return 0;
}

// Only run when invoked directly, so tests can import DELETES/TEST_USERS.
if (process.argv[1] && process.argv[1].endsWith("purge-test-accounts.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    },
  );
}
