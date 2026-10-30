import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/20261030230000_harden_signup_and_exam_rls.sql",
  ),
  "utf8",
);

describe("production security hardening migration", () => {
  it("never grants admin from user-controlled signup metadata", () => {
    expect(migration).not.toMatch(/raw_user_meta_data\s*->>\s*'role'\s*=\s*'admin'/i);
    expect(migration).toMatch(/else\s+'student'::public\.app_role/i);
  });

  it("retires legacy direct submission and answer writes", () => {
    expect(migration).toMatch(/drop policy if exists "student creates own submission"/i);
    expect(migration).toMatch(/revoke insert on public\.submissions from authenticated/i);
    expect(migration).toMatch(
      /revoke execute on function public\.submit_assessment\(uuid, jsonb\)/i,
    );
    expect(migration).toMatch(/drop policy if exists "student inserts own answers"/i);
    expect(migration).toMatch(/drop policy if exists "student updates own unreleased answers"/i);
    expect(migration).toMatch(/revoke insert on public\.answers from authenticated/i);
  });

  it("allows students to read only their own draft or released answers", () => {
    expect(migration).toMatch(/s\.status in \('in_progress', 'released'\)/i);
    expect(migration).not.toMatch(/s\.status <>\s*'released'/i);
  });
});
