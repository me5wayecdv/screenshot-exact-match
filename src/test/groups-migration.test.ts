import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/20261103210000_teacher_groups.sql",
  ),
  "utf8",
);

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

describe("teacher groups migration", () => {
  const sql = stripComments(migration);

  it("creates teacher_groups with a unique join code and group_members with a status", () => {
    expect(sql).toMatch(/create table if not exists public\.teacher_groups/i);
    expect(sql).toMatch(/join_code text not null unique/i);
    expect(sql).toMatch(/create table if not exists public\.group_members/i);
    expect(sql).toMatch(/check \(status in \('pending', 'approved', 'rejected'\)\)/i);
  });

  it("locks both tables behind RLS, teacher-only for groups and RPC-only for members", () => {
    expect(sql).toMatch(/alter table public\.teacher_groups enable row level security/i);
    expect(sql).toMatch(/alter table public\.group_members enable row level security/i);
    expect(sql).toMatch(/create policy "teacher manages own groups" on public\.teacher_groups/i);
    expect(sql).not.toMatch(/create policy[^;]*on public\.group_members/i);
  });

  it("generates a 12-char group code in the create function", () => {
    const body = sql.slice(sql.indexOf("function public.create_teacher_group"));
    expect(body).toMatch(/substr\(md5\(random\(\)::text/i);
    expect(body).toMatch(/, 1, 12\)/i);
  });

  it("starts a group join as pending on both the link and the membership, assigning nothing", () => {
    const join = sql.slice(sql.indexOf("function public.join_group"));
    const body = join.slice(0, join.indexOf("end $$;"));
    expect(body).toMatch(/values \(g\.teacher_id, auth\.uid\(\), 'pending', now\(\)\)/i);
    expect(body).toMatch(/values \(g\.id, auth\.uid\(\), 'pending', now\(\)\)/i);
    expect(body).not.toMatch(/insert into public\.assessment_assignments/i);
  });

  it("requires a name before a group request can be sent", () => {
    const join = sql.slice(sql.indexOf("function public.join_group"));
    expect(join).toMatch(/raise exception 'name_required'/i);
  });

  it("lets a rejected student ask again without re-opening an approved membership", () => {
    expect(sql).toMatch(
      /update public\.group_members\s+set status = 'pending'[\s\S]*?where group_id = g\.id and student_id = auth\.uid\(\) and status = 'rejected'/i,
    );
  });

  it("only ever decides a pending (or, when approving, a rejected) membership", () => {
    const decide = sql.slice(sql.indexOf("function public.decide_group_membership"));
    const body = decide.slice(0, decide.indexOf("end $$;"));
    expect(body).toMatch(
      /where group_id = _group and student_id = _student\s+and \(status = 'pending' or \(_approve and status = 'rejected'\)\)/i,
    );
  });

  it("approving a group request also approves the teacher link and assigns open published everyone-exams", () => {
    const decide = sql.slice(sql.indexOf("function public.decide_group_membership"));
    const body = decide.slice(0, decide.indexOf("end $$;"));
    expect(body).toMatch(/update public\.teacher_students\s+set status = 'approved'/i);
    expect(body).toMatch(/insert into public\.assessment_assignments/i);
    expect(body).toMatch(/a\.audience_mode = 'auto_all'/i);
    expect(body).toMatch(/a\.status = 'published'/i);
  });

  it("a group rejection never unlinks an approved student", () => {
    const decide = sql.slice(sql.indexOf("function public.decide_group_membership"));
    const body = decide.slice(0, decide.indexOf("end $$;"));
    expect(body).toMatch(/has_approved_group/i);
    expect(body).toMatch(/if link_pending and not has_approved_group then/i);
  });
});
