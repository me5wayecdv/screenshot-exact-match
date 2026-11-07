/**
 * D1 smoke script (Phase 1, run with bun — NOT part of the app bundle).
 *
 *   bun scripts/d1-smoke.ts
 *
 * Proves, against real SQLite (bun:sqlite, same SQL dialect family as
 * D1), that:
 *   1. schema/d1-auth.sql + schema/d1-schema.sql apply cleanly, and
 *   2. the D1 auth store + the student-groups proof of concept return
 *      exactly the right rows, including the approved-member-only rule.
 *
 * This is NOT a D1 binding test (no Worker is involved); it validates
 * the SQL and the code that runs it. A real D1 deployment still needs
 * the binding plumbing documented in src/server/d1.ts.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSession, signIn, signOut, signUp } from "../src/lib/cloudflare-auth.ts";
import { createD1AuthStore, type D1Database } from "../src/server/d1-auth-store.ts";
import { listStudentGroups } from "../src/server/d1-groups.ts";

const root = join(import.meta.dir, "..");

function assert(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${label}`);
  }
}

const sqlite = new Database(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec(readFileSync(join(root, "schema/d1-auth.sql"), "utf8"));
sqlite.exec(readFileSync(join(root, "schema/d1-schema.sql"), "utf8"));
console.log("PASS: schema applies cleanly");

// Minimal D1 adapter over bun:sqlite. D1 callers always use
// .prepare().bind().all()/first()/run(), so bind() is the path used.
const d1: D1Database = {
  prepare(sql: string) {
    const stmt = sqlite.query(sql);
    const make = (params: unknown[]) => ({
      async all() {
        return { results: stmt.all(...params) as Record<string, unknown>[] };
      },
      async first() {
        return (stmt.get(...params) as Record<string, unknown> | undefined) ?? null;
      },
      async run() {
        stmt.run(...params);
      },
    });
    return {
      bind: (...params: unknown[]) => make(params),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => undefined,
    } as never;
  },
  async batch(statements: never[]) {
    // bun:sqlite has no batch(); run sequentially (D1 batch() is
    // atomic in production — see d1-auth-store.ts).
    for (const s of statements as unknown as { run(): Promise<unknown> }[]) await s.run();
  },
};

const store = createD1AuthStore(d1);
const now = new Date().toISOString();

// Seed a teacher + two students + a group, using the store + raw SQL
// for the group rows (group creation is a Phase 2 server function).
const teacher = await signUp(store, {
  email: "teacher@example.com",
  password: "correct-horse-battery",
  fullName: "Test Teacher",
  role: "school_teacher",
  iterations: 1000,
});
const approved = await signUp(store, {
  email: "approved@example.com",
  password: "correct-horse-battery",
  fullName: "Approved Student",
  role: "student",
  iterations: 1000,
});
const pending = await signUp(store, {
  email: "pending@example.com",
  password: "correct-horse-battery",
  fullName: "Pending Student",
  role: "student",
  iterations: 1000,
});
const outsider = await signUp(store, {
  email: "outsider@example.com",
  password: "correct-horse-battery",
  fullName: "Outsider Student",
  role: "student",
  iterations: 1000,
});
assert(teacher.userId !== approved.userId, "sign-up creates distinct users");

sqlite
  .query(
    "INSERT INTO teacher_groups (id, teacher_id, name, school_year, days, time_text, notes, join_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .run(
    "group-1",
    teacher.userId,
    "Sunday Group",
    "First secondary",
    '["sun","wed"]',
    "16:00",
    "",
    "TESTCODE123456",
    now,
  );
sqlite
  .query(
    "INSERT INTO group_members (group_id, student_id, status, requested_at) VALUES (?, ?, ?, ?)",
  )
  .run("group-1", approved.userId, "approved", now);
sqlite
  .query(
    "INSERT INTO group_members (group_id, student_id, status, requested_at) VALUES (?, ?, ?, ?)",
  )
  .run("group-1", pending.userId, "pending", now);

const approvedGroups = await listStudentGroups(d1, approved.userId);
assert(approvedGroups.length === 1, "approved member sees exactly 1 group");
assert(approvedGroups[0]?.groupName === "Sunday Group", "group name matches");
assert(
  approvedGroups[0]?.days.join(",") === "sun,wed",
  "days JSON array is parsed back to strings",
);
assert(approvedGroups[0]?.teacherName === "Test Teacher", "teacher name resolves via profiles");
assert((await listStudentGroups(d1, pending.userId)).length === 0, "pending member sees no groups");
assert((await listStudentGroups(d1, outsider.userId)).length === 0, "non-member sees no groups");

// Auth through the D1 store: correct sign-in, wrong password, revoke.
const signed = await signIn(store, {
  email: "approved@example.com",
  password: "correct-horse-battery",
});
assert(
  (await checkSession(store, signed.sessionToken)).userId === approved.userId,
  "D1 session checks out",
);
let wrongRejected = false;
try {
  await signIn(store, { email: "approved@example.com", password: "wrong" });
} catch {
  wrongRejected = true;
}
assert(wrongRejected, "wrong password rejected via D1 store");
await signOut(store, signed.sessionToken);
let revokedRejected = false;
try {
  await checkSession(store, signed.sessionToken);
} catch {
  revokedRejected = true;
}
assert(revokedRejected, "signed-out session rejected via D1 store");

console.log(process.exitCode ? "SMOKE: FAILED" : "SMOKE: ALL PASS");
