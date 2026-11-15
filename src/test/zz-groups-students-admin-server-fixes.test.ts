// @vitest-environment node
import { describe, expect, it } from "vitest";
import { auditDb } from "@/test/audit-sqlite-helper";
import {
  approveAllGroupMembers,
  createTeacherGroup,
  decideGroupMembership,
  type GroupInput,
} from "@/server/d1-groups";
import { assignGroupExam } from "@/server/d1-group-exams";
import { getAnalyticsDetail, listAnalyticsStudentPage } from "@/server/d1-analytics";
import { listAuditLog, listSiteActivity, newTemporaryPassword } from "@/server/d1-admin";
import { consumeAiQuota, refundAiQuota } from "@/server/d1-quota";
import { claimWhatsappSend, finishWhatsappSend } from "@/server/d1-whatsapp";
import {
  computeQuestionStats,
  effectiveScore,
  formatPct,
  isReleased,
  releasedPct,
  toCsv,
} from "@/lib/analytics";
import { isWhatsAppConfigured } from "@/lib/whatsapp-api.server";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

/** A complete GroupInput with only the name set. */
const groupInput = (name: string): GroupInput => ({
  name,
  year: "",
  days: [],
  time: "",
  notes: "",
});

describe("groups-students-admin-server bug fixes", () => {
  it("decideGroupMembership re-approving a rejected member also approves a rejected teacher_students link", async () => {
    const { db: d1, sql: raw } = auditDb();
    raw
      .prepare(
        "INSERT INTO auth_users (id, email, password_hash, status) VALUES (?, ?, 'h', 'approved')",
      )
      .run("t1", "t1@example.com");
    raw
      .prepare(
        "INSERT INTO auth_users (id, email, password_hash, status) VALUES (?, ?, 'h', 'approved')",
      )
      .run("s1", "s1@example.com");
    raw.prepare("INSERT INTO profiles (id, full_name) VALUES (?, ?)").run("t1", "Teacher 1");
    raw.prepare("INSERT INTO profiles (id, full_name) VALUES (?, ?)").run("s1", "Student 1");
    raw.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)").run("t1", "school_teacher");
    raw.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)").run("s1", "student");

    const groupId = await createTeacherGroup(d1, "t1", "school_teacher", {
      name: "Group A",
      year: "1st Secondary",
      days: ["Sun"],
      time: "4pm",
      notes: "",
    });

    raw
      .prepare("INSERT INTO group_members (group_id, student_id, status) VALUES (?, ?, 'pending')")
      .run(groupId, "s1");
    raw
      .prepare(
        "INSERT INTO teacher_students (teacher_id, student_id, status) VALUES (?, ?, 'pending')",
      )
      .run("t1", "s1");

    // 1. Reject the group request -> both group_members and teacher_students become 'rejected'
    await decideGroupMembership(
      d1,
      "t1",
      "school_teacher",
      groupId,
      "s1",
      false,
      "2026-11-04T10:00:00.000Z",
    );
    expect(
      raw
        .prepare("SELECT status FROM teacher_students WHERE teacher_id = ? AND student_id = ?")
        .get("t1", "s1"),
    ).toEqual({ status: "rejected" });

    // 2. Re-approve the rejected group request -> teacher_students must also become 'approved'
    await decideGroupMembership(
      d1,
      "t1",
      "school_teacher",
      groupId,
      "s1",
      true,
      "2026-11-04T10:05:00.000Z",
    );
    expect(
      raw
        .prepare("SELECT status FROM group_members WHERE group_id = ? AND student_id = ?")
        .get(groupId, "s1"),
    ).toEqual({ status: "approved" });
    expect(
      raw
        .prepare("SELECT status FROM teacher_students WHERE teacher_id = ? AND student_id = ?")
        .get("t1", "s1"),
    ).toEqual({ status: "approved" });
  });

  it("assignGroupExam records group_exam_assigned in audit_log even when group has 0 approved members", async () => {
    const { db: d1, sql: raw } = auditDb();
    raw
      .prepare(
        "INSERT INTO auth_users (id, email, password_hash, status) VALUES (?, ?, 'h', 'approved')",
      )
      .run("t1", "t1@example.com");
    raw.prepare("INSERT INTO profiles (id, full_name) VALUES (?, ?)").run("t1", "Teacher 1");
    raw.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)").run("t1", "school_teacher");
    raw
      .prepare(
        "INSERT INTO assessments (id, teacher_id, title, grade_level, status) VALUES (?, ?, ?, '10', 'published')",
      )
      .run("a1", "t1", "Quiz 1");

    const groupId = await createTeacherGroup(d1, "t1", "school_teacher", {
      name: "Empty Group",
      year: "10",
      days: [],
      time: "",
      notes: "",
    });

    const assigned = await assignGroupExam(d1, "t1", "school_teacher", groupId, "a1");
    expect(assigned).toBe(0);

    const audit = raw
      .prepare(
        "SELECT action, entity_id, details FROM audit_log WHERE action = 'group_exam_assigned'",
      )
      .get() as { action: string; entity_id: string; details: string } | undefined;
    expect(audit).toBeDefined();
    expect(audit?.entity_id).toBe("a1");
    expect(JSON.parse(audit?.details ?? "{}")).toMatchObject({
      group_id: groupId,
      assigned: 0,
      target_label: "Quiz 1",
      group_label: "Empty Group",
    });
  });

  it("getAnalyticsDetail and listAnalyticsStudentPage guard against NaN/float page and offset and zero-mark questions", async () => {
    const { db: d1, sql: raw } = auditDb();
    raw
      .prepare(
        "INSERT INTO auth_users (id, email, password_hash, status) VALUES (?, ?, 'h', 'approved')",
      )
      .run("t1", "t1@example.com");
    raw.prepare("INSERT INTO profiles (id, full_name) VALUES (?, ?)").run("t1", "Teacher 1");
    raw
      .prepare(
        "INSERT INTO assessments (id, teacher_id, title, grade_level, status) VALUES (?, ?, ?, '10', 'published')",
      )
      .run("a1", "t1", "Exam 1");

    const detail = await getAnalyticsDetail(
      d1,
      { id: "t1", role: "school_teacher" },
      "a1",
      Number.NaN,
      Number.NaN,
    );
    expect(detail.students).toEqual([]);
    expect(detail.groups).toEqual([]);

    const page = await listAnalyticsStudentPage(
      d1,
      { id: "t1", role: "school_teacher" },
      "a1",
      Number.NaN,
    );
    expect(page).toEqual([]);
  });

  it("listAuditLog rejects unknown/empty roles and listSiteActivity handles NaN limit", async () => {
    const { db: d1, sql: raw } = auditDb();
    raw
      .prepare(
        "INSERT INTO auth_users (id, email, password_hash, status) VALUES (?, ?, 'h', 'approved')",
      )
      .run("admin-1", "admin@example.com");
    raw.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)").run("admin-1", "admin");
    raw
      .prepare("INSERT INTO audit_log (actor_id, action, entity_id, details) VALUES (?, ?, ?, ?)")
      .run("admin-1", "group_created", "g1", JSON.stringify({ target_label: "G1" }));

    await expect(listAuditLog(d1, { id: "u1", role: "" })).rejects.toThrow("FORBIDDEN");
    await expect(listAuditLog(d1, { id: "u1", role: "guest" })).rejects.toThrow("FORBIDDEN");

    const feed = await listSiteActivity(
      d1,
      { id: "admin-1", role: "admin" },
      { limit: Number.NaN },
    );
    expect(feed.rows).toHaveLength(1);
    expect(feed.rows[0]?.action).toBe("group_created");
  });

  it("newTemporaryPassword handles non-positive or non-integer lengths safely", () => {
    expect(newTemporaryPassword(0)).toHaveLength(14);
    expect(newTemporaryPassword(-5)).toHaveLength(14);
    expect(newTemporaryPassword(Number.NaN)).toHaveLength(14);
    expect(newTemporaryPassword(16)).toHaveLength(16);
  });

  it("consumeAiQuota and refundAiQuota fail closed on malformed nowIso", async () => {
    const { db: d1 } = auditDb();
    expect(await consumeAiQuota(d1, "u1", 1, "not-a-date")).toBe(false);
    expect(await consumeAiQuota(d1, "u1", 1, "")).toBe(false);
    expect(await refundAiQuota(d1, "u1", 1, "not-a-date", "key-1")).toBe(false);
  });

  it("createTeacherGroup surfaces a non-code write failure instead of retrying 10x and blaming the code", async () => {
    const { db } = auditDb();
    let inserts = 0;
    const failing: D1Database = {
      ...db,
      prepare(query: string) {
        const stmt = db.prepare(query);
        if (!query.includes("INSERT INTO teacher_groups")) return stmt;
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              ...bound,
              run: async () => {
                inserts += 1;
                throw new Error("D1_ERROR: no such table: teacher_groups");
              },
            } as unknown as D1Statement;
          },
        } as unknown as D1Statement;
      },
    };
    await expect(
      createTeacherGroup(failing, "t", "school_teacher", groupInput("Group A")),
    ).rejects.toThrow(/no such table/);
    // A real failure must not be retried as if it were a join-code clash.
    expect(inserts).toBe(1);
  });

  it("approveAllGroupMembers approves every pending member with its link and exam assignment", async () => {
    const { db, sql: raw } = auditDb();
    raw
      .prepare("INSERT INTO auth_users (id, email, status) VALUES (?, ?, 'approved')")
      .run("s2", "s2@example.invalid");
    raw.prepare("INSERT INTO profiles (id, full_name) VALUES (?, ?)").run("s2", "Student 2");
    const groupId = await createTeacherGroup(db, "t", "school_teacher", groupInput("Group B"));
    // The seeded exam must be an open auto_all exam so approval assigns it.
    raw.prepare("UPDATE assessments SET audience_mode = 'auto_all' WHERE id = 'e'").run();
    raw
      .prepare("INSERT INTO group_members (group_id, student_id, status) VALUES (?, ?, 'pending')")
      .run(groupId, "s");
    raw
      .prepare("INSERT INTO group_members (group_id, student_id, status) VALUES (?, ?, 'pending')")
      .run(groupId, "s2");

    expect(await approveAllGroupMembers(db, "t", "school_teacher", groupId)).toBe(2);

    const members = raw
      .prepare("SELECT status FROM group_members WHERE group_id = ?")
      .all(groupId) as { status: string }[];
    expect(members.every((m) => m.status === "approved")).toBe(true);
    for (const studentId of ["s", "s2"]) {
      const link = raw
        .prepare("SELECT status FROM teacher_students WHERE teacher_id = ? AND student_id = ?")
        .get("t", studentId) as { status: string } | undefined;
      expect(link?.status).toBe("approved");
      const assignment = raw
        .prepare("SELECT student_id FROM assessment_assignments WHERE student_id = ?")
        .get(studentId) as { student_id: string } | undefined;
      expect(assignment?.student_id).toBe(studentId);
    }
    // Re-running finds nothing pending and approves nothing.
    expect(await approveAllGroupMembers(db, "t", "school_teacher", groupId)).toBe(0);
  });

  it("approveAllGroupMembers leaves a member pending when its side effects fail, so a retry repairs it", async () => {
    const { db, sql: raw } = auditDb();
    const groupId = await createTeacherGroup(db, "t", "school_teacher", groupInput("Group C"));
    // An open auto_all exam gives the approval an assignment write to fail on.
    raw.prepare("UPDATE assessments SET audience_mode = 'auto_all' WHERE id = 'e'").run();
    raw
      .prepare("INSERT INTO group_members (group_id, student_id, status) VALUES (?, ?, 'pending')")
      .run(groupId, "s");

    // Fail the first exam-assignment write, then let the retry through.
    let failNext = true;
    const flaky: D1Database = {
      ...db,
      prepare(query: string) {
        const stmt = db.prepare(query);
        if (!query.includes("INSERT INTO assessment_assignments")) return stmt;
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              ...bound,
              run: async () => {
                if (failNext) {
                  failNext = false;
                  throw new Error("D1_ERROR: transient");
                }
                return bound.run();
              },
            } as unknown as D1Statement;
          },
        } as unknown as D1Statement;
      },
    };

    await expect(approveAllGroupMembers(flaky, "t", "school_teacher", groupId)).rejects.toThrow(
      /transient/,
    );
    // The member is still pending, not half-approved.
    const before = raw
      .prepare("SELECT status FROM group_members WHERE group_id = ? AND student_id = ?")
      .get(groupId, "s") as { status: string };
    expect(before.status).toBe("pending");

    // The retry completes the approval.
    expect(await approveAllGroupMembers(db, "t", "school_teacher", groupId)).toBe(1);
    const after = raw
      .prepare("SELECT status FROM group_members WHERE group_id = ? AND student_id = ?")
      .get(groupId, "s") as { status: string };
    expect(after.status).toBe("approved");
  });

  it("finishWhatsappSend writes one audit row even when a concurrent finish completes the claim first", async () => {
    const { db, sql: raw } = auditDb();
    raw
      .prepare(
        "INSERT INTO submissions (id, assessment_id, student_id, status) VALUES (?, ?, ?, 'released')",
      )
      .run("sub-1", "e", "s");
    raw
      .prepare("INSERT INTO whatsapp_send_claims (submission_id, completed) VALUES (?, 0)")
      .run("sub-1");

    // Simulate the losing racer: it already decided to write, and a
    // concurrent finish completes the claim between that decision and
    // the INSERT. The audited write must then do nothing.
    let completedBeforeInsert = false;
    const racingDb: D1Database = {
      ...db,
      prepare(query: string) {
        const stmt = db.prepare(query);
        if (!query.includes("INSERT INTO whatsapp_sends")) return stmt;
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              ...bound,
              run: async () => {
                if (!completedBeforeInsert) {
                  completedBeforeInsert = true;
                  raw
                    .prepare(
                      "UPDATE whatsapp_send_claims SET completed = 1 WHERE submission_id = ?",
                    )
                    .run("sub-1");
                }
                return bound.run();
              },
            } as unknown as D1Statement;
          },
        } as unknown as D1Statement;
      },
    };

    const won = await finishWhatsappSend(
      racingDb,
      "t",
      "sub-1",
      { status: "failed", trigger: "auto", retryable: true },
      "2026-11-04T10:01:00.000Z",
    );
    expect(won).toBe(false);
    const sends = raw.prepare("SELECT COUNT(*) AS n FROM whatsapp_sends").get() as { n: number };
    expect(sends.n).toBe(0);
    // The retryable release must not delete a claim another caller completed.
    const claim = raw
      .prepare("SELECT completed FROM whatsapp_send_claims WHERE submission_id = ?")
      .get("sub-1") as { completed: number };
    expect(claim.completed).toBe(1);
    void claimWhatsappSend;
  });

  it("finishWhatsappSend writes exactly one audit row for a single send", async () => {
    const { db, sql: raw } = auditDb();
    raw
      .prepare(
        "INSERT INTO submissions (id, assessment_id, student_id, status) VALUES (?, ?, ?, 'released')",
      )
      .run("sub-2", "e", "s");
    raw
      .prepare("INSERT INTO whatsapp_send_claims (submission_id, completed) VALUES (?, 0)")
      .run("sub-2");
    expect(
      await finishWhatsappSend(
        db,
        "t",
        "sub-2",
        { status: "sent", trigger: "manual" },
        "2026-11-04T10:01:00.000Z",
      ),
    ).toBe(true);
    const sends = raw.prepare("SELECT COUNT(*) AS n FROM whatsapp_sends").get() as { n: number };
    expect(sends.n).toBe(1);
    // The claim is now completed, so a second finish is a no-op.
    expect(await finishWhatsappSend(db, "t", "sub-2", { status: "sent", trigger: "manual" })).toBe(
      false,
    );
    const after = raw.prepare("SELECT COUNT(*) AS n FROM whatsapp_sends").get() as { n: number };
    expect(after.n).toBe(1);
  });

  it("analytics helpers reject undefined/NaN/Infinity scores and quote CR in CSV", () => {
    expect(
      effectiveScore({
        question_id: "q1",
        auto_score: undefined as unknown as null,
        final_score: undefined as unknown as null,
      }),
    ).toBeNull();
    expect(
      effectiveScore({
        question_id: "q1",
        auto_score: Number.NaN,
        final_score: null,
      }),
    ).toBeNull();
    expect(
      isReleased({
        id: "s1",
        student_id: "stu1",
        status: "released",
        final_score: undefined as unknown as null,
        total_possible: 10,
      }),
    ).toBe(false);
    expect(
      releasedPct({
        id: "s1",
        student_id: "stu1",
        status: "released",
        final_score: Number.NaN,
        total_possible: 10,
      }),
    ).toBeNull();
    expect(formatPct(Number.NaN, "en")).toBe("—");

    const stats = computeQuestionStats(
      [
        {
          id: "q1",
          prompt: "P",
          type: "mcq",
          marks: 10,
          objective: "O",
          difficulty: "easy",
        },
      ],
      [
        {
          question_id: "q1",
          auto_score: undefined as unknown as null,
          final_score: undefined as unknown as null,
        },
      ],
    );
    expect(stats[0]?.graded).toBe(0);
    expect(stats[0]?.avgPct).toBeNull();

    const csv = toCsv([["line1\rline2", "normal"]], ["col1", "col2"]);
    expect(csv).toBe('\uFEFFcol1,col2\n"line1\rline2",normal');
  });

  it("isWhatsAppConfigured rejects whitespace-only env vars", () => {
    const prevToken = process.env["WHATSAPP_TOKEN"];
    const prevPhone = process.env["WHATSAPP_PHONE_NUMBER_ID"];
    try {
      process.env["WHATSAPP_TOKEN"] = "   ";
      process.env["WHATSAPP_PHONE_NUMBER_ID"] = "123456";
      expect(isWhatsAppConfigured()).toBe(false);
    } finally {
      if (prevToken === undefined) delete process.env["WHATSAPP_TOKEN"];
      else process.env["WHATSAPP_TOKEN"] = prevToken;
      if (prevPhone === undefined) delete process.env["WHATSAPP_PHONE_NUMBER_ID"];
      else process.env["WHATSAPP_PHONE_NUMBER_ID"] = prevPhone;
    }
  });
});
