/**
 * Tests for the D1 groups + group-exams server functions
 * (src/server/d1-groups.ts, src/server/d1-group-exams.ts).
 *
 * Uses a stateful dispatch fake for D1Database, like
 * src/test/d1-take-gate.test.ts but mutating: inserts/updates/
 * deletes change the fake's tables, so approval side effects
 * (teacher-link approval, assignment rows, audit rows, cascades)
 * are observable without a Worker binding. The fake dispatches on
 * SQL substrings, mirroring the real queries' shapes.
 *
 * Security assertions covered here (the task's required four):
 * - a non-owner teacher cannot manage another teacher's group
 *   (update / delete / roster / decide / approve-all / assign);
 * - a pending student sees no group exams;
 * - a non-member gets no rows from my_group_exams;
 * - a student request for another student's data is denied
 *   (teacher-only reads reject a student caller, and a roster
 *   never contains students from another group).
 */
import { describe, expect, it } from "vitest";
import {
  approveAllGroupMembers,
  createTeacherGroup,
  decideGroupMembership,
  deleteTeacherGroup,
  getGroupRoster,
  joinGroup,
  listPendingGroupRequests,
  listStudentGroups,
  listTeacherGroups,
  updateTeacherGroup,
} from "@/server/d1-groups";
import { assignGroupExam, listGroupExams, listTeacherAssessments } from "@/server/d1-group-exams";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type MemberStatus = "pending" | "approved" | "rejected";
type Assessment = {
  id: string;
  teacherId: string;
  title: string;
  status: string;
  audienceMode: string;
  dueAt: string | null;
  createdAt: string;
};

type State = {
  groups: Map<
    string,
    {
      id: string;
      teacherId: string;
      name: string;
      schoolYear: string;
      days: string;
      timeText: string;
      notes: string;
      joinCode: string;
      createdAt: string;
    }
  >;
  members: Map<
    string,
    { groupId: string; studentId: string; status: MemberStatus; requestedAt: string }
  >;
  links: Map<string, MemberStatus>;
  profiles: Map<string, string>;
  roles: Map<string, string>;
  assessments: Map<string, Assessment>;
  groupExams: Set<string>; // `${groupId}:${assessmentId}`
  assignments: Set<string>; // `${assessmentId}:${studentId}`
  audit: Array<{ actor: string; action: string; entity: string | null; details: string }>;
};

function baseState(): State {
  const s: State = {
    groups: new Map(),
    members: new Map(),
    links: new Map(),
    profiles: new Map(),
    roles: new Map(),
    assessments: new Map(),
    groupExams: new Set(),
    assignments: new Set(),
    audit: [],
  };
  s.groups.set("g1", {
    id: "g1",
    teacherId: "t1",
    name: "Group One",
    schoolYear: "3rd secondary",
    days: '["sat"]',
    timeText: "10:00",
    notes: "",
    joinCode: "GROUPCODE123",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  s.groups.set("g2", {
    id: "g2",
    teacherId: "t2",
    name: "Other Teacher Group",
    schoolYear: "2nd secondary",
    days: "[]",
    timeText: "",
    notes: "",
    joinCode: "OTHERCODE456",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  s.groups.set("g3", {
    id: "g3",
    teacherId: "t1",
    name: "Group Three",
    schoolYear: "3rd secondary",
    days: "[]",
    timeText: "",
    notes: "",
    joinCode: "THIRDCODE789",
    createdAt: "2026-11-02T00:00:00.000Z",
  });
  const member = (groupId: string, studentId: string, status: MemberStatus) =>
    s.members.set(`${groupId}:${studentId}`, {
      groupId,
      studentId,
      status,
      requestedAt: "2026-11-02T00:00:00.000Z",
    });
  member("g1", "s1", "approved");
  member("g1", "s2", "pending");
  member("g1", "s6", "pending");
  member("g2", "s3", "approved");
  member("g3", "s6", "approved");
  s.links.set("t1:s1", "approved");
  s.links.set("t1:s2", "pending");
  s.links.set("t1:s6", "approved");
  s.links.set("t2:s3", "approved");
  s.profiles.set("t1", "Teacher One");
  s.profiles.set("t2", "Teacher Two");
  s.profiles.set("s1", "Student One");
  s.profiles.set("s2", "Student Two");
  s.profiles.set("s3", "Student Three");
  s.profiles.set("s4", "Student Four");
  s.profiles.set("s5", "Student Five");
  s.profiles.set("s6", "Student Six");
  s.profiles.set("s7", "");
  s.roles.set("t1", "school_teacher");
  s.roles.set("t2", "tutor");
  s.roles.set("s1", "student");
  s.roles.set("s2", "student");
  s.roles.set("s3", "student");
  s.roles.set("s4", "student");
  s.roles.set("s5", "student");
  s.roles.set("s6", "student");
  s.roles.set("s7", "student");
  const assessment = (
    id: string,
    teacherId: string,
    title: string,
    status: string,
    audienceMode: string,
  ) =>
    s.assessments.set(id, {
      id,
      teacherId,
      title,
      status,
      audienceMode,
      dueAt: null,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
  assessment("a1", "t1", "Everyone Exam", "published", "auto_all");
  assessment("a2", "t1", "Draft Exam", "draft", "explicit");
  assessment("a3", "t1", "Linked Exam", "published", "explicit");
  assessment("a4", "t2", "Other Teacher Exam", "published", "explicit");
  s.groupExams.add("g1:a3");
  s.groupExams.add("g1:a2");
  s.assignments.add("a3:s1");
  return s;
}

function fakeDb(s: State): D1Database {
  const kindOf = (sql: string): string => {
    if (sql.startsWith("INSERT INTO teacher_groups")) return "insertGroup";
    if (sql.startsWith("INSERT INTO group_members")) return "insertMember";
    if (sql.startsWith("INSERT INTO teacher_students")) return "insertLink";
    if (sql.startsWith("INSERT INTO assessment_assignments")) return "insertAssignment";
    if (sql.startsWith("INSERT INTO group_exams")) return "insertGroupExam";
    if (sql.startsWith("INSERT INTO audit_log")) return "insertAudit";
    if (sql.startsWith("UPDATE teacher_groups SET")) return "updateGroup";
    if (sql.startsWith("DELETE FROM teacher_groups")) return "deleteGroup";
    if (
      sql.startsWith("UPDATE group_members SET") &&
      sql.includes("WHERE group_id = ? AND status = 'pending'")
    )
      return "updateMembersBulk";
    // Join re-open: 3 params (now, groupId, studentId), unlike the
    // decide update's 4 — it must not fall into updateMember.
    if (sql.startsWith("UPDATE group_members SET") && sql.includes("AND status = 'rejected'"))
      return "updateMemberReopen";
    if (sql.startsWith("UPDATE group_members SET")) return "updateMember";
    if (sql.startsWith("UPDATE teacher_students SET status = 'approved'"))
      return "updateLinkApproved";
    if (sql.startsWith("UPDATE teacher_students SET status = 'rejected'"))
      return "updateLinkRejected";
    if (sql.startsWith("UPDATE teacher_students SET status = 'pending'"))
      return "updateLinkPending";
    if (sql.includes("FROM teacher_groups WHERE id = ? AND teacher_id = ?")) return "owner";
    if (sql.includes("FROM teacher_groups g LEFT JOIN group_members")) return "teacherGroups";
    if (sql.includes("FROM teacher_groups WHERE join_code")) return "groupByCode";
    if (sql.includes("SELECT status FROM group_members WHERE group_id")) return "memberStatus";
    if (sql.includes("FROM group_members gm LEFT JOIN profiles")) return "roster";
    if (sql.includes("FROM group_members gm JOIN teacher_groups g")) {
      if (sql.includes("g.teacher_id = ?")) return "hasApprovedGroup";
      if (sql.includes("gm.status = 'pending'")) return "pendingRequests";
      return "studentGroups";
    }
    // Checked BEFORE the member-list queries: the existing-assignments
    // query embeds the approved-members subquery, so substring order
    // matters — it must not be mistaken for approvedMembers.
    if (sql.includes("FROM assessment_assignments WHERE assessment_id = ?"))
      return "existingAssignments";
    if (sql.includes("FROM group_members WHERE group_id = ? AND status = 'pending'"))
      return "pendingMembers";
    if (sql.includes("FROM group_members WHERE group_id = ? AND status = 'approved'"))
      return "approvedMembers";
    if (sql.includes("SELECT full_name FROM profiles WHERE id")) return "profileName";
    if (sql.includes("FROM user_roles WHERE user_id")) return "userRole";
    if (sql.includes("FROM teacher_students") && sql.includes("status = 'pending'"))
      return "linkPending";
    if (sql.includes("FROM assessments WHERE teacher_id = ? AND status = 'published'"))
      return "autoAll";
    if (sql.includes("FROM group_exams ge JOIN assessments a")) {
      if (sql.includes("a.title"))
        return sql.includes("EXISTS") ? "groupExamsMember" : "groupExamsOwner";
      return "linkedPublished";
    }
    if (sql.includes("FROM assessments WHERE teacher_id = ?")) return "teacherAssessments";
    if (sql.includes("FROM assessments WHERE id = ? AND teacher_id = ?")) return "assessmentOwner";
    return `unknown:${sql.slice(0, 80)}`;
  };

  const stmt = (kind: string, params: unknown[], sql = ""): D1Statement => {
    const first = async <T>(): Promise<T | null> => {
      switch (kind) {
        case "owner": {
          const g = s.groups.get(params[0] as string);
          return (g && g.teacherId === params[1] ? { one: 1 } : null) as unknown as T | null;
        }
        case "groupByCode": {
          const code = String(params[0]).trim().toUpperCase();
          const g = [...s.groups.values()].find((x) => x.joinCode === code);
          return (g ? { id: g.id, teacher_id: g.teacherId } : null) as unknown as T | null;
        }
        case "memberStatus": {
          const m = s.members.get(`${params[0]}:${params[1]}`);
          return (m ? { status: m.status } : null) as unknown as T | null;
        }
        case "profileName": {
          const name = s.profiles.get(params[0] as string);
          return (name === undefined ? null : { full_name: name }) as unknown as T | null;
        }
        case "userRole": {
          const role = s.roles.get(params[0] as string);
          return (role ? { role } : null) as unknown as T | null;
        }
        case "linkPending":
          return (s.links.get(`${params[0]}:${params[1]}`) === "pending"
            ? { one: 1 }
            : null) as unknown as T | null;
        case "hasApprovedGroup": {
          const found = [...s.members.values()].some((m) => {
            const g = s.groups.get(m.groupId);
            return (
              g?.teacherId === params[0] && m.studentId === params[1] && m.status === "approved"
            );
          });
          return (found ? { one: 1 } : null) as unknown as T | null;
        }
        case "assessmentOwner": {
          const a = s.assessments.get(params[0] as string);
          return (a && a.teacherId === params[1] ? { one: 1 } : null) as unknown as T | null;
        }
        default:
          return null;
      }
    };
    const all = async <T>(): Promise<{ results?: T[] }> => {
      switch (kind) {
        case "teacherGroups": {
          const rows = [...s.groups.values()]
            .filter((g) => g.teacherId === params[0])
            .map((g) => {
              const ms = [...s.members.values()].filter((m) => m.groupId === g.id);
              return {
                group_id: g.id,
                name: g.name,
                school_year: g.schoolYear,
                days: g.days,
                time_text: g.timeText,
                notes: g.notes,
                join_code: g.joinCode,
                approved_count: ms.filter((m) => m.status === "approved").length,
                pending_count: ms.filter((m) => m.status === "pending").length,
                created_at: g.createdAt,
              };
            });
          return { results: rows as unknown as T[] };
        }
        case "roster": {
          const rows = [...s.members.values()]
            .filter((m) => m.groupId === params[0])
            .sort((a, b) => {
              const pa = a.status === "pending" ? 1 : 0;
              const pb = b.status === "pending" ? 1 : 0;
              return pb - pa || (a.requestedAt < b.requestedAt ? 1 : -1);
            })
            .map((m) => ({
              student_id: m.studentId,
              full_name: s.profiles.get(m.studentId) ?? "",
              status: m.status,
              requested_at: m.requestedAt,
            }));
          return { results: rows as unknown as T[] };
        }
        case "studentGroups": {
          const rows = [...s.members.values()]
            .filter((m) => m.studentId === params[0] && m.status === "approved")
            .map((m) => {
              const g = s.groups.get(m.groupId)!;
              return {
                group_id: g.id,
                group_name: g.name,
                school_year: g.schoolYear,
                days: g.days,
                time_text: g.timeText,
                teacher_id: g.teacherId,
                teacher_name: s.profiles.get(g.teacherId) ?? "",
              };
            });
          return { results: rows as unknown as T[] };
        }
        case "pendingRequests": {
          const rows = [...s.members.values()]
            .filter((m) => m.studentId === params[0] && m.status === "pending")
            .map((m) => {
              const g = s.groups.get(m.groupId)!;
              return {
                group_id: g.id,
                group_name: g.name,
                teacher_id: g.teacherId,
                teacher_name: s.profiles.get(g.teacherId) ?? "",
                requested_at: m.requestedAt,
              };
            });
          return { results: rows as unknown as T[] };
        }
        case "pendingMembers":
          return {
            results: [...s.members.values()]
              .filter((m) => m.groupId === params[0] && m.status === "pending")
              .map((m) => ({ student_id: m.studentId })) as unknown as T[],
          };
        case "approvedMembers":
          return {
            results: [...s.members.values()]
              .filter((m) => m.groupId === params[0] && m.status === "approved")
              .map((m) => ({ student_id: m.studentId })) as unknown as T[],
          };
        case "autoAll":
          return {
            results: [...s.assessments.values()]
              .filter(
                (a) =>
                  a.teacherId === params[0] &&
                  a.status === "published" &&
                  a.audienceMode === "auto_all" &&
                  (a.dueAt === null || a.dueAt > (params[1] as string)),
              )
              .map((a) => ({ id: a.id })) as unknown as T[],
          };
        case "linkedPublished":
          return {
            results: [...s.groupExams]
              .filter((k) => k.startsWith(`${params[0]}:`))
              .map((k) => k.split(":")[1] as string)
              .filter((id) => s.assessments.get(id)?.status === "published")
              .map((assessment_id) => ({ assessment_id })) as unknown as T[],
          };
        case "groupExamsOwner":
          return {
            results: [...s.groupExams]
              .filter((k) => k.startsWith(`${params[0]}:`))
              .map((k) => {
                const a = s.assessments.get(k.split(":")[1] as string)!;
                return {
                  assessment_id: a.id,
                  title: a.title,
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
              .map((a) => ({
                assessment_id: a.id,
                title: a.title,
                published: 1,
              })) as unknown as T[],
          };
        }
        case "teacherAssessments":
          return {
            results: [...s.assessments.values()]
              .filter((a) => a.teacherId === params[0])
              .map((a) => ({ id: a.id, title: a.title, status: a.status })) as unknown as T[],
          };
        case "existingAssignments":
          return {
            results: [...s.assignments]
              .filter((k) => k.startsWith(`${params[0]}:`))
              .map((k) => k.split(":")[1] as string)
              .filter((studentId) =>
                [...s.members.values()].some(
                  (m) =>
                    m.groupId === params[1] && m.studentId === studentId && m.status === "approved",
                ),
              )
              .map((student_id) => ({ student_id })) as unknown as T[],
          };
        default:
          return { results: [] };
      }
    };
    const run = async (): Promise<unknown> => {
      switch (kind) {
        case "insertGroup": {
          const id = params[0] as string;
          const teacherId = params[1] as string;
          const name = params[2] as string;
          const schoolYear = params[3] as string;
          const days = params[4] as string;
          const timeText = params[5] as string;
          const notes = params[6] as string;
          const joinCode = params[7] as string;
          s.groups.set(id, {
            id,
            teacherId,
            name,
            schoolYear,
            days,
            timeText,
            notes,
            joinCode,
            createdAt: "2026-11-03T00:00:00.000Z",
          });
          return undefined;
        }
        case "insertMember": {
          // Status is a SQL literal ('pending'), not a bound param:
          // params are (groupId, studentId, requestedAt).
          const groupId = params[0] as string;
          const studentId = params[1] as string;
          const requestedAt = params[2] as string;
          const status: MemberStatus = sql.includes("'approved'") ? "approved" : "pending";
          if (!s.members.has(`${groupId}:${studentId}`)) {
            s.members.set(`${groupId}:${studentId}`, {
              groupId,
              studentId,
              status,
              requestedAt,
            });
          }
          return undefined;
        }
        case "insertLink": {
          // Status is a SQL literal; params are (teacherId, studentId, now).
          const teacherId = params[0] as string;
          const studentId = params[1] as string;
          const status: MemberStatus = sql.includes("'approved'") ? "approved" : "pending";
          if (!s.links.has(`${teacherId}:${studentId}`)) {
            s.links.set(`${teacherId}:${studentId}`, status);
          }
          return undefined;
        }
        case "insertAssignment":
          s.assignments.add(`${params[0]}:${params[1]}`);
          return undefined;
        case "insertGroupExam":
          s.groupExams.add(`${params[0]}:${params[1]}`);
          return undefined;
        case "insertAudit":
          s.audit.push({
            actor: params[0] as string,
            action: params[1] as string,
            entity: params[2] as string | null,
            details: params[3] as string,
          });
          return undefined;
        case "updateGroup": {
          const name = params[0] as string;
          const schoolYear = params[1] as string;
          const days = params[2] as string;
          const timeText = params[3] as string;
          const notes = params[4] as string;
          const groupId = params[5] as string;
          const teacherId = params[6] as string;
          const g = s.groups.get(groupId);
          if (g && g.teacherId === teacherId) {
            g.name = name;
            g.schoolYear = schoolYear;
            g.days = days;
            g.timeText = timeText;
            g.notes = notes;
          }
          return undefined;
        }
        case "updateMember": {
          const status = params[0] as string;
          const groupId = params[2] as string;
          const studentId = params[3] as string;
          const m = s.members.get(`${groupId}:${studentId}`);
          if (m) m.status = status as MemberStatus;
          return undefined;
        }
        case "updateMemberReopen": {
          const groupId = params[1] as string;
          const studentId = params[2] as string;
          const m = s.members.get(`${groupId}:${studentId}`);
          if (m && m.status === "rejected") m.status = "pending";
          return undefined;
        }
        case "updateMembersBulk": {
          const groupId = params[1] as string;
          for (const m of s.members.values()) {
            if (m.groupId === groupId && m.status === "pending") m.status = "approved";
          }
          return undefined;
        }
        case "updateLinkApproved": {
          const key = `${params[1]}:${params[2]}`;
          if (s.links.get(key) === "pending") s.links.set(key, "approved");
          return undefined;
        }
        case "updateLinkRejected": {
          const key = `${params[1]}:${params[2]}`;
          if (s.links.get(key) === "pending") s.links.set(key, "rejected");
          return undefined;
        }
        case "updateLinkPending": {
          const key = `${params[1]}:${params[2]}`;
          if (s.links.get(key) === "rejected") s.links.set(key, "pending");
          return undefined;
        }
        case "deleteGroup": {
          const groupId = params[0] as string;
          const teacherId = params[1] as string;
          const g = s.groups.get(groupId);
          if (g && g.teacherId === teacherId) {
            s.groups.delete(groupId);
            for (const key of [...s.members.keys()]) {
              if (key.startsWith(`${groupId}:`)) s.members.delete(key);
            }
            for (const key of [...s.groupExams]) {
              if (key.startsWith(`${groupId}:`)) s.groupExams.delete(key);
            }
          }
          return undefined;
        }
        default:
          return undefined;
      }
    };
    return {
      bind: () => stmt(kind, params, sql),
      first,
      all,
      run,
    } as unknown as D1Statement;
  };
  return {
    prepare(sql: string): D1Statement {
      const kind = kindOf(sql);
      let params: unknown[] = [];
      const s0 = stmt(kind, params, sql);
      return {
        bind: (...p: unknown[]) => {
          params = p;
          return stmt(kind, params, sql);
        },
        first: s0.first,
        all: s0.all,
        run: s0.run,
      } as unknown as D1Statement;
    },
  };
}

const NOW = "2026-11-03T20:00:00.000Z";
const input = {
  name: "New Group",
  year: "1st secondary",
  days: ["sun", "wed"],
  time: "16:00",
  notes: "note",
};

describe("teacher group ownership", () => {
  it("a non-owner teacher cannot update another teacher's group", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await expect(updateTeacherGroup(db, "t1", "school_teacher", "g2", input)).rejects.toThrow(
      "not_owner",
    );
    expect(s.groups.get("g2")!.name).toBe("Other Teacher Group");
  });

  it("a non-owner teacher cannot delete another teacher's group", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await expect(deleteTeacherGroup(db, "t1", "school_teacher", "g2")).rejects.toThrow("not_owner");
    expect(s.groups.has("g2")).toBe(true);
  });

  it("a non-owner teacher cannot read another teacher's roster", async () => {
    const db = fakeDb(baseState());
    await expect(getGroupRoster(db, "t1", "school_teacher", "g2")).rejects.toThrow("not_owner");
  });

  it("a non-owner teacher cannot decide membership or approve-all", async () => {
    const db = fakeDb(baseState());
    await expect(
      decideGroupMembership(db, "t1", "school_teacher", "g2", "s3", true, NOW),
    ).rejects.toThrow("not_owner");
    await expect(approveAllGroupMembers(db, "t1", "school_teacher", "g2", NOW)).rejects.toThrow(
      "not_owner",
    );
  });

  it("a student cannot create, update, or delete a group", async () => {
    const db = fakeDb(baseState());
    await expect(createTeacherGroup(db, "s1", "student", input)).rejects.toThrow("not_teacher");
    await expect(updateTeacherGroup(db, "s1", "student", "g1", input)).rejects.toThrow(
      "not_teacher",
    );
    await expect(deleteTeacherGroup(db, "s1", "student", "g1")).rejects.toThrow("not_teacher");
  });

  it("a student request for another student's data is denied (teacher-only reads)", async () => {
    const db = fakeDb(baseState());
    await expect(getGroupRoster(db, "s1", "student", "g1")).rejects.toThrow("not_teacher");
    await expect(listTeacherGroups(db, "s1", "student")).rejects.toThrow("not_teacher");
    await expect(listTeacherAssessments(db, "s1", "student")).rejects.toThrow("not_teacher");
  });

  it("a roster never contains students from another group", async () => {
    const db = fakeDb(baseState());
    const roster = await getGroupRoster(db, "t1", "school_teacher", "g1");
    expect(roster.map((r) => r.studentId).sort()).toEqual(["s1", "s2", "s6"]);
    expect(roster.map((r) => r.studentId)).not.toContain("s3");
  });
});

describe("teacher group CRUD", () => {
  it("a teacher creates a group with a 12-char uppercase code, listed with zero counts", async () => {
    const s = baseState();
    const db = fakeDb(s);
    const id = await createTeacherGroup(db, "t1", "school_teacher", input);
    const created = s.groups.get(id)!;
    expect(created.joinCode).toMatch(/^[0-9A-F]{12}$/);
    const groups = await listTeacherGroups(db, "t1", "school_teacher");
    const mine = groups.find((g) => g.groupId === id)!;
    expect(mine.name).toBe("New Group");
    expect(mine.days).toEqual(["sun", "wed"]);
    expect(mine.approvedCount).toBe(0);
    expect(mine.pendingCount).toBe(0);
  });

  it("a teacher updates their own group; an empty name is rejected", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await updateTeacherGroup(db, "t1", "school_teacher", "g1", { ...input, name: "Renamed" });
    expect(s.groups.get("g1")!.name).toBe("Renamed");
    await expect(
      updateTeacherGroup(db, "t1", "school_teacher", "g1", { ...input, name: "   " }),
    ).rejects.toThrow("invalid_student");
  });

  it("deleting your own group cascades its members and exam links", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await deleteTeacherGroup(db, "t1", "school_teacher", "g1");
    expect(s.groups.has("g1")).toBe(false);
    expect([...s.members.keys()].some((k) => k.startsWith("g1:"))).toBe(false);
    expect([...s.groupExams].some((k) => k.startsWith("g1:"))).toBe(false);
    expect(await listGroupExams(db, "t1", "g1")).toEqual([]);
  });
});

describe("join and decisions", () => {
  it("joining by code lands pending on link and membership and assigns nothing", async () => {
    const s = baseState();
    const db = fakeDb(s);
    const groupId = await joinGroup(db, "s4", "student", "groupcode123");
    expect(groupId).toBe("g1");
    expect(s.members.get("g1:s4")?.status).toBe("pending");
    expect(s.links.get("t1:s4")).toBe("pending");
    expect(s.assignments.has("a1:s4")).toBe(false);
    expect(s.assignments.has("a3:s4")).toBe(false);
  });

  it("join rejects bad codes, teacher callers, and nameless students", async () => {
    const db = fakeDb(baseState());
    await expect(joinGroup(db, "s4", "student", "NOPE12345678")).rejects.toThrow("invalid_code");
    await expect(joinGroup(db, "t1", "school_teacher", "GROUPCODE123")).rejects.toThrow(
      "only_students",
    );
    await expect(joinGroup(db, "s7", "student", "GROUPCODE123")).rejects.toThrow("name_required");
  });

  it("a rejected student can ask again; an approved membership is left untouched", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await decideGroupMembership(db, "t1", "school_teacher", "g1", "s2", false, NOW);
    expect(s.members.get("g1:s2")?.status).toBe("rejected");
    await joinGroup(db, "s2", "student", "GROUPCODE123");
    expect(s.members.get("g1:s2")?.status).toBe("pending");
    await joinGroup(db, "s1", "student", "GROUPCODE123");
    expect(s.members.get("g1:s1")?.status).toBe("approved");
  });

  it("approving assigns the open auto_all exam and the published linked exam, never the draft", async () => {
    const s = baseState();
    const db = fakeDb(s);
    const decision = await decideGroupMembership(db, "t1", "school_teacher", "g1", "s2", true, NOW);
    expect(decision).toBe("approved");
    expect(s.members.get("g1:s2")?.status).toBe("approved");
    expect(s.links.get("t1:s2")).toBe("approved");
    expect(s.assignments.has("a1:s2")).toBe(true);
    expect(s.assignments.has("a3:s2")).toBe(true);
    expect(s.assignments.has("a2:s2")).toBe(false);
    expect(s.audit.some((a) => a.action === "group_membership_decision")).toBe(true);
  });

  it("approving a rejected request re-opens it; deciding a decided request fails", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await decideGroupMembership(db, "t1", "school_teacher", "g1", "s2", false, NOW);
    const decision = await decideGroupMembership(db, "t1", "school_teacher", "g1", "s2", true, NOW);
    expect(decision).toBe("approved");
    await expect(
      decideGroupMembership(db, "t1", "school_teacher", "g1", "s2", false, NOW),
    ).rejects.toThrow("no_pending_request");
    await expect(
      decideGroupMembership(db, "t1", "school_teacher", "g1", "s4", true, NOW),
    ).rejects.toThrow("no_pending_request");
  });

  it("a rejection never unlinks a student approved in another group of the same teacher", async () => {
    const s = baseState();
    const db = fakeDb(s);
    // s6 is approved in g3 (same teacher t1) and pending in g1.
    await decideGroupMembership(db, "t1", "school_teacher", "g1", "s6", false, NOW);
    expect(s.members.get("g1:s6")?.status).toBe("rejected");
    expect(s.links.get("t1:s6")).toBe("approved");
    expect(s.members.get("g3:s6")?.status).toBe("approved");
  });

  it("a rejection ends a still-pending teacher link when no approved group remains", async () => {
    const s = baseState();
    const db = fakeDb(s);
    await decideGroupMembership(db, "t1", "school_teacher", "g1", "s2", false, NOW);
    expect(s.links.get("t1:s2")).toBe("rejected");
  });

  it("approve-all approves only pending members, assigns their exams, then returns 0", async () => {
    const s = baseState();
    const db = fakeDb(s);
    const count = await approveAllGroupMembers(db, "t1", "school_teacher", "g1", NOW);
    expect(count).toBe(2);
    expect(s.members.get("g1:s2")?.status).toBe("approved");
    expect(s.members.get("g1:s6")?.status).toBe("approved");
    expect(s.members.get("g1:s1")?.status).toBe("approved");
    expect(s.assignments.has("a1:s2")).toBe(true);
    expect(s.assignments.has("a3:s6")).toBe(true);
    expect(await approveAllGroupMembers(db, "t1", "school_teacher", "g1", NOW)).toBe(0);
  });
});

describe("student group reads", () => {
  it("a student sees only approved groups, never pending ones", async () => {
    const db = fakeDb(baseState());
    expect((await listStudentGroups(db, "s1")).map((g) => g.groupId)).toEqual(["g1"]);
    expect(await listStudentGroups(db, "s2")).toEqual([]);
    expect((await listStudentGroups(db, "s3")).map((g) => g.groupId)).toEqual(["g2"]);
  });

  it("a student sees only their own pending requests", async () => {
    const db = fakeDb(baseState());
    expect((await listPendingGroupRequests(db, "s2")).map((g) => g.groupId)).toEqual(["g1"]);
    expect(await listPendingGroupRequests(db, "s1")).toEqual([]);
  });
});

describe("group exams visibility", () => {
  it("the owning teacher sees draft and published linked exams", async () => {
    const db = fakeDb(baseState());
    const exams = await listGroupExams(db, "t1", "g1");
    expect(exams.map((e) => e.assessmentId).sort()).toEqual(["a2", "a3"]);
    expect(exams.find((e) => e.assessmentId === "a2")?.published).toBe(false);
    expect(exams.find((e) => e.assessmentId === "a3")?.published).toBe(true);
  });

  it("an approved member sees published linked exams only", async () => {
    const db = fakeDb(baseState());
    const exams = await listGroupExams(db, "s1", "g1");
    expect(exams.map((e) => e.assessmentId)).toEqual(["a3"]);
  });

  it("a pending student sees no group exams", async () => {
    const db = fakeDb(baseState());
    expect(await listGroupExams(db, "s2", "g1")).toEqual([]);
  });

  it("a non-member gets no rows from my_group_exams", async () => {
    const db = fakeDb(baseState());
    expect(await listGroupExams(db, "s4", "g1")).toEqual([]);
    expect(await listGroupExams(db, "s3", "g1")).toEqual([]);
  });

  it("a non-owner teacher gets no rows from my_group_exams", async () => {
    const db = fakeDb(baseState());
    expect(await listGroupExams(db, "t2", "g1")).toEqual([]);
  });
});

describe("assign group exam", () => {
  it("assigning links the exam and assigns approved members only, returning the new count", async () => {
    const s = baseState();
    const db = fakeDb(s);
    // a1 is published but not yet linked to g1; s1 is the only approved member.
    const count = await assignGroupExam(db, "t1", "school_teacher", "g1", "a1");
    expect(count).toBe(1);
    expect(s.groupExams.has("g1:a1")).toBe(true);
    expect(s.assignments.has("a1:s1")).toBe(true);
    expect(s.assignments.has("a1:s2")).toBe(false);
    // Re-assigning is idempotent and returns 0 new members.
    expect(await assignGroupExam(db, "t1", "school_teacher", "g1", "a1")).toBe(0);
    expect(s.audit.some((a) => a.action === "group_exam_assigned")).toBe(true);
  });

  it("assigning rejects a non-owner teacher and another teacher's assessment", async () => {
    const db = fakeDb(baseState());
    await expect(assignGroupExam(db, "t2", "tutor", "g1", "a1")).rejects.toThrow("not_owner");
    await expect(assignGroupExam(db, "t1", "school_teacher", "g1", "a4")).rejects.toThrow(
      "not_owner",
    );
    await expect(assignGroupExam(db, "s1", "student", "g1", "a1")).rejects.toThrow("not_teacher");
  });

  it("assigning to a group with no approved members links but assigns nobody", async () => {
    const s = baseState();
    const db = fakeDb(s);
    // Remove g1's approved member: s1 rejected via decide is not possible
    // (approved is not decidable), so use a fresh group with no members.
    const id = await createTeacherGroup(db, "t1", "school_teacher", input);
    const count = await assignGroupExam(db, "t1", "school_teacher", id, "a1");
    expect(count).toBe(0);
    expect(s.groupExams.has(`${id}:a1`)).toBe(true);
    const exams = await listGroupExams(db, "t1", id);
    expect(exams.map((e) => e.assessmentId)).toEqual(["a1"]);
  });

  it("a teacher lists only their own assessments for the assign dropdown", async () => {
    const db = fakeDb(baseState());
    expect(
      (await listTeacherAssessments(db, "t1", "school_teacher")).map((a) => a.id).sort(),
    ).toEqual(["a1", "a2", "a3"]);
    expect((await listTeacherAssessments(db, "t2", "tutor")).map((a) => a.id)).toEqual(["a4"]);
  });
});
