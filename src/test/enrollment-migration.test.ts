import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../supabase/migrations/20261103180000_enrollment_approval.sql",
  ),
  "utf8",
);

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

describe("enrollment approval migration", () => {
  const sql = stripComments(migration);

  it("adds the status column and grandfathers existing links as approved", () => {
    expect(sql).toMatch(/add column if not exists status text not null default 'approved'/i);
    expect(sql).toMatch(/check \(status in \('pending', 'approved', 'rejected'\)\)/i);
  });

  it("starts a new join as pending and assigns nothing at that point", () => {
    const join = sql.slice(sql.indexOf("function public.join_teacher"));
    const body = join.slice(0, join.indexOf("end $$;"));
    expect(body).toMatch(/values \(t, auth\.uid\(\), 'pending', now\(\)\)/i);
    // The whole point: no assignment rows before approval.
    expect(body).not.toMatch(/insert into public\.assessment_assignments/i);
  });

  it("requires a name before a request can be sent", () => {
    expect(sql).toMatch(/raise exception 'name_required'/i);
  });

  it("lets a rejected student ask again without re-opening an approved link", () => {
    expect(sql).toMatch(
      /update public\.teacher_students\s+set status = 'pending'[\s\S]*?where teacher_id = t and student_id = auth\.uid\(\) and status = 'rejected'/i,
    );
  });

  it("only ever decides a pending (or, when approving, a rejected) row", () => {
    expect(sql).toMatch(
      /where teacher_id = t and student_id = _student\s+and \(status = 'pending' or \(_approve and status = 'rejected'\)\)/i,
    );
  });

  it("assigns open published everyone-exams on approval, never on request", () => {
    const decide = sql.slice(sql.indexOf("function public.decide_enrollment"));
    const body = decide.slice(0, decide.indexOf("end $$;"));
    expect(body).toMatch(/insert into public\.assessment_assignments/i);
    expect(body).toMatch(/a\.audience_mode = 'auto_all'/i);
    expect(body).toMatch(/a\.status = 'published'/i);
  });

  it("publishing counts approved students only", () => {
    const publish = sql.slice(sql.indexOf("function public.set_assessment_status"));
    const body = publish.slice(0, publish.indexOf("end $$;"));
    expect(body).toMatch(/where teacher_id = auth\.uid\(\) and status = 'approved'/i);
    expect(body).toMatch(/ts\.status = 'approved'/i);
  });

  it("keeps pending students out of the teacher's profile read", () => {
    const policy = sql.slice(sql.indexOf('create policy "teacher profile readable'));
    expect(policy).toMatch(/public\.is_approved_student\(user_id, auth\.uid\(\)\)/i);
  });

  it("scopes every new function away from anon", () => {
    for (const fn of [
      "decide_enrollment(uuid, boolean)",
      "approve_all_enrollments()",
      "my_student_roster()",
      "my_pending_enrollments()",
    ]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon;`);
      expect(sql).toContain(`grant execute on function public.${fn} to authenticated;`);
    }
  });
});
