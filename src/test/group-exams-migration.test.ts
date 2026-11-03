import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/20261104090000_group_exams.sql",
  ),
  "utf8",
);

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

describe("group exams migration", () => {
  const sql = stripComments(migration);

  it("creates group_exams keyed by (group_id, assessment_id) with cascading FKs", () => {
    expect(sql).toMatch(/create table if not exists public\.group_exams/i);
    expect(sql).toMatch(/primary key \(group_id, assessment_id\)/i);
    expect(sql).toMatch(
      /group_id uuid not null references public\.teacher_groups \(id\) on delete cascade/i,
    );
    expect(sql).toMatch(
      /assessment_id uuid not null references public\.assessments \(id\) on delete cascade/i,
    );
  });

  it("locks group_exams behind RLS with no direct policies (RPC-only)", () => {
    expect(sql).toMatch(/alter table public\.group_exams enable row level security/i);
    expect(sql).not.toMatch(/create policy[^;]*on public\.group_exams/i);
  });

  it("assign_group_exam requires group ownership and assessment ownership", () => {
    const body = sql.slice(sql.indexOf("function public.assign_group_exam"));
    const fn = body.slice(0, body.indexOf("end $$;"));
    expect(fn).toMatch(/if not public\.is_group_owner\(_group\) then raise exception 'not_owner'/i);
    expect(fn).toMatch(/where a\.id = _assessment and a\.teacher_id = t/i);
  });

  it("assign_group_exam links idempotently and assigns approved members of that group only", () => {
    const body = sql.slice(sql.indexOf("function public.assign_group_exam"));
    const fn = body.slice(0, body.indexOf("end $$;"));
    expect(fn).toMatch(
      /insert into public\.group_exams \(group_id, assessment_id\)\s+values \(_group, _assessment\)\s+on conflict do nothing/i,
    );
    expect(fn).toMatch(
      /insert into public\.assessment_assignments \(assessment_id, student_id\)\s+select _assessment, gm\.student_id\s+from public\.group_members gm\s+where gm\.group_id = _group and gm\.status = 'approved'\s+on conflict do nothing/i,
    );
    expect(fn).toMatch(/insert into public\.audit_log \(actor_id, action, entity_id, details\)/i);
    expect(fn).toMatch(/'group_exam_assigned'/i);
  });

  it("my_group_exams shows drafts only to the owner and published exams only to approved members", () => {
    const body = sql.slice(sql.indexOf("function public.my_group_exams"));
    const fn = body.slice(0, body.indexOf("$$;"));
    expect(fn).toMatch(/public\.is_group_owner\(_group\)/i);
    expect(fn).toMatch(/gm\.status = 'approved'/i);
    expect(fn).toMatch(/a\.status = 'published'/i);
    expect(fn).toMatch(/\(a\.status = 'published'\)/i);
  });

  it("approving a group request also assigns that group's published linked exams", () => {
    const body = sql.slice(sql.indexOf("function public.decide_group_membership"));
    const fn = body.slice(0, body.indexOf("end $$;"));
    expect(fn).toMatch(
      /insert into public\.assessment_assignments \(assessment_id, student_id\)\s+select ge\.assessment_id, _student\s+from public\.group_exams ge\s+join public\.assessments a on a\.id = ge\.assessment_id\s+where ge\.group_id = _group\s+and a\.status = 'published'\s+on conflict do nothing/i,
    );
  });

  it("approve-all also assigns that group's published linked exams to approved members", () => {
    const body = sql.slice(sql.indexOf("function public.approve_all_group_members"));
    const fn = body.slice(0, body.indexOf("end $$;"));
    expect(fn).toMatch(/from public\.group_exams ge/i);
    expect(fn).toMatch(
      /join public\.group_members gm on gm\.group_id = _group and gm\.status = 'approved'/i,
    );
    expect(fn).toMatch(/a\.status = 'published'/i);
  });

  it("keeps the auto_all assignment for other exams untouched in both approval paths", () => {
    const decide = sql.slice(sql.indexOf("function public.decide_group_membership"));
    expect(decide).toMatch(/a\.audience_mode = 'auto_all'/i);
    const approveAll = sql.slice(sql.indexOf("function public.approve_all_group_members"));
    expect(approveAll).toMatch(/a\.audience_mode = 'auto_all'/i);
  });

  it("revokes the new functions from public/anon and grants them to authenticated only", () => {
    expect(sql).toMatch(
      /revoke all on function public\.assign_group_exam\(uuid, uuid\) from public, anon/i,
    );
    expect(sql).toMatch(/revoke all on function public\.my_group_exams\(uuid\) from public, anon/i);
    expect(sql).toMatch(
      /grant execute on function public\.assign_group_exam\(uuid, uuid\) to authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.my_group_exams\(uuid\) to authenticated/i,
    );
  });
});
