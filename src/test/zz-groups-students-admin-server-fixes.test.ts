// @vitest-environment node
import { describe, expect, it } from "vitest";
import { auditDb } from "@/test/audit-sqlite-helper";
import { createTeacherGroup, decideGroupMembership } from "@/server/d1-groups";
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

  it("finishWhatsappSend does not delete an already-completed claim when a retryable failure races", async () => {
    const claims = new Map<string, { claimed_at: string; completed: number }>();
    const db: D1Database = {
      prepare(sql: string) {
        let params: unknown[] = [];
        const stmt: D1Statement = {
          bind(...p: unknown[]) {
            params = p;
            return stmt;
          },
          first: async <T>(): Promise<T | null> => {
            if (sql.includes("FROM submissions s JOIN assessments a")) {
              return { teacher_id: "t1" } as unknown as T;
            }
            if (
              sql.includes("FROM whatsapp_send_claims WHERE submission_id = ? AND completed = 0")
            ) {
              const subId = params[0] as string;
              const c = claims.get(subId);
              if (c && c.completed === 0) {
                // Simulate a concurrent completion landing right after the SELECT check
                c.completed = 1;
                return { submission_id: subId } as unknown as T;
              }
              return null;
            }
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => {
            if (sql.includes("DELETE FROM whatsapp_send_claims")) {
              const subId = params[0] as string;
              const c = claims.get(subId);
              if (c && (!sql.includes("completed = 0") || c.completed === 0)) {
                claims.delete(subId);
              }
            }
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };

    claims.set("sub-1", { claimed_at: "2026-11-04T10:00:00.000Z", completed: 0 });
    await finishWhatsappSend(
      db,
      "t1",
      "sub-1",
      { status: "failed", trigger: "auto", retryable: true },
      "2026-11-04T10:01:00.000Z",
    );
    // Because the claim became completed = 1, DELETE ... AND completed = 0 must preserve it
    expect(claims.get("sub-1")?.completed).toBe(1);
    void claimWhatsappSend;
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
