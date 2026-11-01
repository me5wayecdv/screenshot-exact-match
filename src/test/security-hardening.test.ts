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
const scaleMigration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/20261031120000_backend_security_and_scale.sql",
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

  it("limits sensitive SECURITY DEFINER helpers to authenticated users", () => {
    expect(scaleMigration).toMatch(
      /revoke all on function public\.has_role\(uuid, public\.app_role\)[\s\S]*?from public, anon/i,
    );
    expect(scaleMigration).toMatch(
      /grant execute on function public\.has_role\(uuid, public\.app_role\)[\s\S]*?to authenticated/i,
    );
    expect(scaleMigration).toMatch(/auth\.uid\(\) is not null and exists/i);
    expect(scaleMigration).toMatch(/create or replace function public\.teacher_grading_page/i);
  });

  it("fails closed for AI quota and stops training-data collection", () => {
    expect(scaleMigration).toMatch(/create or replace function public\.consume_ai_rate_quota/i);
    expect(scaleMigration).toMatch(
      /minute_units \+ _units > 30 or v_row\.day_units \+ _units > 500/i,
    );
    expect(scaleMigration).toMatch(/revoke insert on public\.ai_training_examples/i);
    expect(scaleMigration).toMatch(/delete from public\.ai_training_examples/i);
  });

  it("keeps join codes private and enforces high-entropy code formats", () => {
    expect(scaleMigration).toMatch(
      /revoke select on public\.profiles from public, anon, authenticated/i,
    );
    expect(scaleMigration).toMatch(/create or replace function public\.my_join_code\(\)/i);
    expect(scaleMigration).toMatch(/profiles_join_code_entropy_check/i);
    expect(scaleMigration).toMatch(/lessons_join_code_entropy_check/i);
  });

  it("uses a unique send claim and atomically writes server-only audit outcomes", () => {
    expect(scaleMigration).toMatch(
      /submission_id uuid primary key references public\.submissions/i,
    );
    expect(scaleMigration).toMatch(/create or replace function public\.claim_whatsapp_send/i);
    expect(scaleMigration).toMatch(
      /grant execute on function public\.claim_whatsapp_send\(uuid\) to service_role/i,
    );
    expect(scaleMigration).toMatch(
      /insert into public\.whatsapp_sends\(submission_id, status, trigger, message_id, error\)/i,
    );
    expect(scaleMigration).toMatch(
      /revoke insert on public\.whatsapp_sends from authenticated, anon/i,
    );
  });
});
