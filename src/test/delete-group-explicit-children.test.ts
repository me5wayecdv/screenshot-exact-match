/**
 * Regression test for SEC-H2 (deep audit 2026-11-12): `ON DELETE CASCADE`
 * is dead at runtime — D1/SQLite enforces foreign keys only with the
 * `foreign_keys` pragma per connection, and no code path in src/ enables
 * it (the pragma exists only in the schema files). `deleteTeacherGroup`
 * therefore must delete its child rows explicitly.
 *
 * The dispatch fake below deliberately does NOT cascade: deleting a
 * teacher_groups row removes only that row, exactly like live D1 with
 * FK enforcement off. (Contrast src/test/d1-groups.test.ts, whose fake
 * simulates the cascade — that is why the bug was invisible there.)
 *
 * Covered:
 * - after deleteTeacherGroup, no group_members / group_exams rows remain
 *   for the deleted group (approved AND pending members), while other
 *   groups' rows are untouched;
 * - the take gate no longer admits a student via the deleted group.
 *   The exam stays linked to a second group the student is NOT a member
 *   of, so pre-fix the gate passes through the orphan g1 link + member
 *   row, and post-fix it denies with NOT_GROUP_MEMBER;
 * - the former member no longer sees the exam via the deleted group.
 */
import { describe, expect, it } from "vitest";
import { deleteTeacherGroup } from "@/server/d1-groups";
import { listGroupExams } from "@/server/d1-group-exams";
import { canTakeAssessment } from "@/server/d1-take-gate";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type MemberStatus = "pending" | "approved" | "rejected";

type State = {
  groups: Map<string, { id: string; teacherId: string; name: string }>;
  members: Map<string, { groupId: string; studentId: string; status: MemberStatus }>;
  groupExams: Set<string>; // `${groupId}:${assessmentId}`
  assessments: Map<string, { id: string; status: string }>;
  assignments: Set<string>; // `${assessmentId}:${studentId}`
  audit: Array<{ actor: string; action: string; entity: string | null }>;
};

function baseState(): State {
  const s: State = {
    groups: new Map(),
    members: new Map(),
    groupExams: new Set(),
    assessments: new Map(),
    assignments: new Set(),
    audit: [],
  };
  s.groups.set("g1", { id: "g1", teacherId: "t1", name: "Group One" });
  s.groups.set("g3", { id: "g3", teacherId: "t1", name: "Group Three" });
  s.members.set("g1:s1", { groupId: "g1", studentId: "s1", status: "approved" });
  s.members.set("g1:s2", { groupId: "g1", studentId: "s2", status: "pending" });
  s.members.set("g3:s6", { groupId: "g3", studentId: "s6", status: "approved" });
  s.assessments.set("a3", { id: "a3", status: "published" });
  // a3 is linked to BOTH groups; s1 is a member of g1 only and is
  // assigned to a3 through the g1 link.
  s.groupExams.add("g1:a3");
  s.groupExams.add("g3:a3");
  s.assignments.add("a3:s1");
  return s;
}

function fakeDb(s: State): D1Database {
  const kindOf = (sql: string): string => {
    if (sql.startsWith("DELETE FROM group_members")) return "deleteMembers";
    if (sql.startsWith("DELETE FROM group_exams")) return "deleteGroupExams";
    if (sql.startsWith("DELETE FROM teacher_groups")) return "deleteGroup";
    if (sql.startsWith("INSERT INTO audit_log")) return "insertAudit";
    if (sql.includes("SELECT name FROM teacher_groups")) return "groupName";
    if (sql.includes("SELECT 1 AS one FROM teacher_groups")) return "owner";
    if (sql.includes("SELECT status, starts_at, due_at FROM assessments")) return "assessment";
    if (sql.includes("FROM assessment_assignments")) return "assignment";
    if (sql.includes("SELECT group_id FROM group_exams")) return "linksForAssessment";
    if (sql.includes("FROM group_members") && sql.includes("status = 'approved'"))
      return "approvedMember";
    if (sql.includes("FROM group_exams ge JOIN assessments a")) {
      return sql.includes("EXISTS") ? "groupExamsMember" : "groupExamsOwner";
    }
    return `unknown:${sql.slice(0, 80)}`;
  };

  const stmt = (kind: string, params: unknown[]): D1Statement => {
    const first = async <T>(): Promise<T | null> => {
      switch (kind) {
        case "owner": {
          const g = s.groups.get(params[0] as string);
          return (g && g.teacherId === params[1] ? { one: 1 } : null) as unknown as T | null;
        }
        case "groupName": {
          const g = s.groups.get(params[0] as string);
          return (g && g.teacherId === params[1] ? { name: g.name } : null) as unknown as T | null;
        }
        case "assessment": {
          const a = s.assessments.get(params[0] as string);
          return (a
            ? { status: a.status, starts_at: null, due_at: null }
            : null) as unknown as T | null;
        }
        case "assignment":
          return (s.assignments.has(`${params[0]}:${params[1]}`)
            ? { one: 1 }
            : null) as unknown as T | null;
        case "approvedMember": {
          const m = s.members.get(`${params[0]}:${params[1]}`);
          return (m && m.status === "approved" ? { one: 1 } : null) as unknown as T | null;
        }
        default:
          return null;
      }
    };
    const all = async <T>(): Promise<{ results?: T[] }> => {
      switch (kind) {
        case "linksForAssessment":
          return {
            results: [...s.groupExams]
              .filter((k) => k.endsWith(`:${params[0]}`))
              .map((k) => ({ group_id: k.split(":")[0] as string })) as unknown as T[],
          };
        case "groupExamsOwner":
          return {
            results: [...s.groupExams]
              .filter((k) => k.startsWith(`${params[0]}:`))
              .map((k) => {
                const a = s.assessments.get(k.split(":")[1] as string)!;
                return {
                  assessment_id: a.id,
                  title: a.id,
                  published: a.status === "published" ? 1 : 0,
                };
              }) as unknown as T[],
          };
        case "groupExamsMember": {
          const isMember = [...s.members.values()].some(
            (m) => m.groupId === params[0] && m.studentId === params[2] && m.status === "approved",
          );
          if (!isMember) return { results: [] };
          return {
            results: [...s.groupExams]
              .filter((k) => k.startsWith(`${params[0]}:`))
              .map((k) => s.assessments.get(k.split(":")[1] as string)!)
              .filter((a) => a.status === "published")
              .map((a) => ({ assessment_id: a.id, title: a.id, published: 1 })) as unknown as T[],
          };
        }
        default:
          return { results: [] };
      }
    };
    const run = async (): Promise<unknown> => {
      switch (kind) {
        case "deleteMembers": {
          // Explicit child delete (the fix): all memberships of the group.
          for (const key of [...s.members.keys()]) {
            if (key.startsWith(`${params[0]}:`)) s.members.delete(key);
          }
          return undefined;
        }
        case "deleteGroupExams": {
          // Explicit child delete (the fix): all exam links of the group.
          for (const key of [...s.groupExams]) {
            if (key.startsWith(`${params[0]}:`)) s.groupExams.delete(key);
          }
          return undefined;
        }
        case "deleteGroup": {
          // Models live D1 with FK enforcement OFF: NO cascade. Only
          // the group row itself is removed.
          const groupId = params[0] as string;
          const teacherId = params[1] as string;
          const g = s.groups.get(groupId);
          if (g && g.teacherId === teacherId) s.groups.delete(groupId);
          return undefined;
        }
        case "insertAudit":
          s.audit.push({
            actor: params[0] as string,
            action: params[1] as string,
            entity: params[2] as string | null,
          });
          return undefined;
        default:
          return undefined;
      }
    };
    return {
      bind: () => stmt(kind, params),
      first,
      all,
      run,
    } as unknown as D1Statement;
  };
  return {
    prepare(sql: string): D1Statement {
      const kind = kindOf(sql);
      let params: unknown[] = [];
      const s0 = stmt(kind, params);
      return {
        bind: (...p: unknown[]) => {
          params = p;
          return stmt(kind, params);
        },
        first: s0.first,
        all: s0.all,
        run: s0.run,
      } as unknown as D1Statement;
    },
  };
}

describe("SEC-H2: deleting a group removes its children explicitly (no cascade)", () => {
  it("no group_members or group_exams rows remain for the deleted group", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await deleteTeacherGroup(db, "t1", "school_teacher", "g1");
    expect(s.groups.has("g1")).toBe(false);
    // Approved AND pending members of g1 are gone…
    expect([...s.members.keys()].some((k) => k.startsWith("g1:"))).toBe(false);
    // …and so are g1's exam links.
    expect([...s.groupExams].some((k) => k.startsWith("g1:"))).toBe(false);
    // Other groups are untouched.
    expect(s.members.get("g3:s6")?.status).toBe("approved");
    expect(s.groupExams.has("g3:a3")).toBe(true);
    expect(s.audit.some((a) => a.action === "group_deleted")).toBe(true);
  });

  it("the take gate no longer admits a student via the deleted group", async () => {
    const s = baseState();
    const db = fakeDb(s);
    // Sanity: before the delete, s1 passes the gate through g1.
    expect(await canTakeAssessment(db, "s1", "a3", "2026-11-12T09:00:00.000Z")).toEqual({
      allowed: true,
    });
    await deleteTeacherGroup(db, "t1", "school_teacher", "g1");
    // a3 is still linked to g3, which s1 never joined: the only path in
    // was the deleted group's link + membership, and both are gone.
    expect(await canTakeAssessment(db, "s1", "a3", "2026-11-12T09:00:00.000Z")).toEqual({
      allowed: false,
      reason: "NOT_GROUP_MEMBER",
    });
    // The former member no longer sees the exam via the deleted group.
    expect(await listGroupExams(db, "s1", "g1")).toEqual([]);
  });
});
