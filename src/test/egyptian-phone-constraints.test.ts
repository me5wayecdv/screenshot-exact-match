/**
 * The Egyptian phone rule, enforced by the DATABASE (2026-11-15).
 *
 * Two layers, both verified against a real SQLite engine here:
 * - schema/d1-schema.sql declares CHECK constraints on
 *   profiles.parent_phone and teacher_profiles.phone (a fresh DB).
 * - schema/migrations/20261115_egyptian_phone_constraints.sql adds
 *   BEFORE INSERT/UPDATE triggers (SQLite cannot ALTER ADD CHECK), so
 *   an existing DB gets the same rule — WITHOUT touching the rows it
 *   already has.
 *
 * The rule: +20 followed by 010/011/012/015 and 8 digits (12 digits
 * after the "+"). NULL stays allowed (a teacher profile has no parent
 * phone; a legacy student row is repaired by the app, never rewritten
 * by a migration).
 *
 * The engine is node:sqlite (Node 22.5+). If the runtime does not
 * expose it, the suite skips instead of failing the whole run.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

// node:sqlite is a Node builtin, so it is loaded through the runtime
// (process.getBuiltinModule) instead of an import — Vite's client
// resolver would try to bundle a "node:" builtin in the jsdom
// environment. If the runtime does not expose it, the suite skips
// instead of failing the whole run.
const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
const DatabaseSync = sqlite?.DatabaseSync ?? null;

type Db = InstanceType<NonNullable<typeof DatabaseSync>>;

/** A fresh database with the full D1 schema (auth + security + app). */
function freshDb(): Db {
  const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
  db.exec(read("schema/d1-auth.sql"));
  db.exec(read("schema/d1-security.sql"));
  db.exec(read("schema/d1-schema.sql"));
  return db;
}

/** A database with the PRE-migration phone columns (no CHECK). */
function legacyDb(): Db {
  const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(":memory:");
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      parent_phone TEXT,
      whatsapp_consent INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE teacher_profiles (
      user_id TEXT PRIMARY KEY,
      phone TEXT
    );
  `);
  return db;
}

/** Create the auth_users row a profile must reference (FK enforced). */
function seedAuthUser(db: Db, id: string): void {
  db.prepare(
    "INSERT INTO auth_users (id, email, password_hash, provider, created_at) VALUES (?, ?, ?, 'password', ?)",
  ).run(id, `${id}@example.com`, "hash", new Date().toISOString());
}

/** Run a write that must be REJECTED by the database. */
function expectRejected(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  expect(threw, "expected the database to reject this write").toBe(true);
}

/** Run a write that must be ACCEPTED by the database. */
function expectAccepted(fn: () => void): void {
  expect(() => fn()).not.toThrow();
}

const VALID = ["+201012345678", "+201112345678", "+201212345678", "+201512345678"];
const INVALID = [
  "01012345678", // local form — the app normalizes it, the DB does not
  "201012345678", // country code without the +
  "+201912345678", // 019 is not an Egyptian mobile prefix
  "+20101234567", // one digit short
  "+2010123456789", // one digit too long
  "+2101012345678", // wrong country code
  "+20101234567a", // a letter
  "+15551234567", // a US number
  "",
  "  +201012345678", // stray whitespace
];

describe.skipIf(!DatabaseSync)("Egyptian phone constraints (SQLite)", () => {
  it("accepts a normalized Egyptian mobile on a fresh database", () => {
    const db = freshDb();
    for (const phone of VALID) {
      const id = `p-${phone}`;
      seedAuthUser(db, id);
      expectAccepted(() =>
        db
          .prepare("INSERT INTO profiles (id, full_name, parent_phone) VALUES (?, ?, ?)")
          .run(id, "Student", phone),
      );
    }
    // NULL is allowed (a teacher profile has no parent phone).
    seedAuthUser(db, "p-null");
    expectAccepted(() =>
      db
        .prepare("INSERT INTO profiles (id, full_name, parent_phone) VALUES (?, ?, NULL)")
        .run("p-null", "Student"),
    );
    db.close();
  });

  it("rejects a phone that is not a normalized Egyptian mobile on a fresh database", () => {
    const db = freshDb();
    for (const phone of INVALID) {
      const id = `bad-${phone}`;
      seedAuthUser(db, id);
      expectRejected(() =>
        db
          .prepare("INSERT INTO profiles (id, full_name, parent_phone) VALUES (?, ?, ?)")
          .run(id, "Student", phone),
      );
    }
    db.close();
  });

  it("applies the same rule to teacher_profiles.phone", () => {
    const db = freshDb();
    seedAuthUser(db, "t1");
    expectAccepted(() =>
      db
        .prepare("INSERT INTO teacher_profiles (user_id, phone) VALUES (?, ?)")
        .run("t1", "+201012345678"),
    );
    for (const phone of INVALID) {
      const id = `t-${phone}`;
      seedAuthUser(db, id);
      expectRejected(() =>
        db.prepare("INSERT INTO teacher_profiles (user_id, phone) VALUES (?, ?)").run(id, phone),
      );
    }
    db.close();
  });

  it("the migration guards NEW writes on an existing database", () => {
    const db = legacyDb();
    db.prepare("INSERT INTO profiles (id, full_name, parent_phone) VALUES (?, ?, ?)").run(
      "legacy",
      "Legacy Student",
      "01012345678",
    );
    db.prepare("INSERT INTO teacher_profiles (user_id, phone) VALUES (?, ?)").run(
      "legacy-t",
      "01012345678",
    );

    db.exec(read("schema/migrations/20261115_egyptian_phone_constraints.sql"));

    // A NEW write is guarded on both tables.
    expectRejected(() =>
      db
        .prepare("INSERT INTO profiles (id, full_name, parent_phone) VALUES (?, ?, ?)")
        .run("new-bad", "Student", "01012345678"),
    );
    expectAccepted(() =>
      db
        .prepare("INSERT INTO profiles (id, full_name, parent_phone) VALUES (?, ?, ?)")
        .run("new-good", "Student", "+201012345678"),
    );
    expectRejected(() =>
      db
        .prepare("INSERT INTO teacher_profiles (user_id, phone) VALUES (?, ?)")
        .run("new-bad-t", "01012345678"),
    );
    expectAccepted(() =>
      db
        .prepare("INSERT INTO teacher_profiles (user_id, phone) VALUES (?, ?)")
        .run("new-good-t", "+201012345678"),
    );
    db.close();
  });

  it("the migration leaves a legacy row alone until its phone changes", () => {
    const db = legacyDb();
    db.prepare("INSERT INTO profiles (id, full_name, parent_phone) VALUES (?, ?, ?)").run(
      "legacy",
      "Legacy Student",
      "01012345678",
    );
    db.exec(read("schema/migrations/20261115_egyptian_phone_constraints.sql"));

    // The row still holds an old-format number: editing ANOTHER
    // column keeps working (the Supabase "NOT VALID" semantics — the
    // migration never scans, rewrites or deletes existing data).
    expectAccepted(() =>
      db.prepare("UPDATE profiles SET full_name = ? WHERE id = ?").run("Renamed", "legacy"),
    );
    // Changing the phone to another invalid value is rejected.
    expectRejected(() =>
      db.prepare("UPDATE profiles SET parent_phone = ? WHERE id = ?").run("201012345678", "legacy"),
    );
    // Changing it to a valid number is allowed — that is the repair
    // path the app uses.
    expectAccepted(() =>
      db
        .prepare("UPDATE profiles SET parent_phone = ? WHERE id = ?")
        .run("+201012345678", "legacy"),
    );
    db.close();
  });

  it("the migration is idempotent (safe to re-run)", () => {
    const db = legacyDb();
    const sql = read("schema/migrations/20261115_egyptian_phone_constraints.sql");
    db.exec(sql);
    expectAccepted(() => db.exec(sql));
    db.close();
  });
});
