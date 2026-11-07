/**
 * Tests for the D1 teacher assistant (src/server/d1-assistant.ts):
 * the drafts-only guard, the counts-only overview (no student names,
 * no individual answers), and the mediated lesson-source upload.
 */
import { describe, expect, it } from "vitest";
import {
  assertAssistantActionAllowed,
  getAssistantOverview,
  uploadLessonSource,
  type Caller,
} from "@/server/d1-assistant";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

function fakeDb(): D1Database {
  const make = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        void params;
        if (sql.includes("SUM(CASE WHEN status")) {
          return { total: 5, drafts: 2, published: 3 } as T;
        }
        if (sql.includes("IN ('awaiting_review'")) {
          return { n: 4 } as T;
        }
        if (sql.includes("status = 'released'")) {
          return { n: 10, avg_pct: 80 } as T;
        }
        return null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    };
    return stmt as unknown as D1Statement;
  };
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
}

function fakeBucket() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    put: async (key: string, value: unknown) => {
      files.set(key, value as Uint8Array);
    },
    get: async (key: string) => {
      const v = files.get(key);
      if (!v) return null;
      return { size: v.length, arrayBuffer: async () => v.buffer as ArrayBuffer };
    },
    delete: async (key: string) => {
      files.delete(key);
    },
  };
}

const TEACHER: Caller = { id: "teacher-1", role: "school_teacher" };
const STUDENT: Caller = { id: "student-1", role: "student" };

describe("D1 teacher assistant (drafts-only)", () => {
  it("refuses create/approve/release actions and allows only chat/explain/overview", () => {
    for (const action of [
      "create_assessment",
      "save_assessment",
      "create",
      "publish",
      "approve_mark",
      "approve",
      "release_results",
      "release",
      "delete_assessment",
      "unknown_action",
    ]) {
      try {
        assertAssistantActionAllowed(action);
        expect.unreachable(`action ${action} should have been refused`);
      } catch (e) {
        expect((e as { code?: string }).code).toBe("FORBIDDEN");
      }
    }
    expect(() => assertAssistantActionAllowed("chat")).not.toThrow();
    expect(() => assertAssistantActionAllowed("explain")).not.toThrow();
    expect(() => assertAssistantActionAllowed("overview")).not.toThrow();
  });

  it("overview returns counts only for the owning teacher, no names or answers", async () => {
    const db = fakeDb();
    const summary = await getAssistantOverview(db, TEACHER);
    expect(summary).toEqual({
      assessments: 5,
      drafts: 2,
      published: 3,
      pendingReviews: 4,
      releasedResults: 10,
      averageReleasedPercent: 80,
      releasedSampleSize: 10,
    });
    expect(Object.keys(summary).join(",")).not.toMatch(/name|answer|response|student/i);
    await expect(getAssistantOverview(db, STUDENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lesson-source upload is mediated under the teacher's own folder, one file per call", async () => {
    const db = fakeDb();
    const bucket = fakeBucket();
    const key = await uploadLessonSource(db, TEACHER, bucket, {
      dataUrl: `data:application/pdf;base64,${btoa("lesson")}`,
      fileName: "lesson.pdf",
    });
    expect(key.startsWith("teacher-1/")).toBe(true);
    expect(key.split("/").length).toBe(3);
    expect(bucket.files.has(key)).toBe(true);
    await expect(
      uploadLessonSource(db, TEACHER, bucket, {
        dataUrl: "data:text/plain;base64,eA==",
        fileName: "x.txt",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      uploadLessonSource(db, STUDENT, bucket, {
        dataUrl: `data:application/pdf;base64,${btoa("lesson")}`,
        fileName: "lesson.pdf",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
