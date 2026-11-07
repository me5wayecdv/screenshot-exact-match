/**
 * Tests for D1 AI quota (src/server/d1-quota.ts) and WhatsApp claims
 * (src/server/d1-whatsapp.ts), using dispatch fakes for D1Database
 * (same pattern as d1-take-gate.test.ts). No live D1 is required.
 */
import { describe, expect, it } from "vitest";
import { consumeAiQuota, getAiQuotaUsage } from "@/server/d1-quota";
import { claimWhatsappSend, finishWhatsappSend } from "@/server/d1-whatsapp";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

type Stmt = D1Statement & { __sql: string; __params: unknown[] };

function fakeDb(
  handler: (
    sql: string,
    params: unknown[],
  ) => { first?: unknown; all?: unknown[]; changes?: number },
): D1Database {
  const make = (sql: string): Stmt => {
    let params: unknown[] = [];
    const stmt = {
      __sql: sql,
      __params: params,
      bind(...p: unknown[]) {
        params = p;
        (stmt as Stmt).__params = p;
        return stmt as unknown as D1Statement;
      },
      first: async <T>(): Promise<T | null> => {
        const r = handler(sql, params);
        return (r.first ?? null) as T | null;
      },
      all: async <T>(): Promise<{ results?: T[] }> => ({
        results: (handler(sql, params).all ?? []) as T[],
      }),
      run: async () => ({ meta: { changes: handler(sql, params).changes ?? 0 } }),
    } as unknown as Stmt;
    return stmt;
  };
  return {
    prepare: (sql: string) => make(sql) as unknown as D1Statement,
    batch: async (stmts: D1Statement[]) => {
      const out: unknown[] = [];
      for (const s of stmts) {
        const st = s as Stmt;
        out.push({ meta: { changes: handler(st.__sql, st.__params).changes ?? 0 } });
      }
      return out;
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------- quota
type QuotaRow = {
  minute_started_at: string;
  minute_units: number;
  day_started_on: string;
  day_units: number;
};

function quotaDb(rows: Map<string, QuotaRow>): D1Database {
  return fakeDb((sql, params) => {
    if (sql.includes("INSERT OR IGNORE INTO ai_rate_limits")) {
      const [userId, minute, day] = params as [string, string, string];
      if (!rows.has(userId)) {
        rows.set(userId, {
          minute_started_at: minute,
          minute_units: 0,
          day_started_on: day,
          day_units: 0,
        });
      }
      return { changes: 0 };
    }
    if (sql.includes("UPDATE ai_rate_limits")) {
      // bind order: minute, minute, units, units, day, day, units, units,
      // now, userId, minute, units, units, 30, day, units, units, 500
      const userId = params[9] as string;
      const minute = params[0] as string;
      const units = params[2] as number;
      const day = params[4] as string;
      const row = rows.get(userId);
      if (!row) return { changes: 0 };
      const newMinute = row.minute_started_at !== minute ? units : row.minute_units + units;
      const newDay = row.day_started_on !== day ? units : row.day_units + units;
      if (newMinute > 30 || newDay > 500) return { changes: 0 };
      row.minute_started_at = minute;
      row.minute_units = newMinute;
      row.day_started_on = day;
      row.day_units = newDay;
      return { changes: 1 };
    }
    if (sql.includes("FROM ai_rate_limits")) {
      const row = rows.get(params[0] as string);
      return { first: row ? { minute_units: row.minute_units, day_units: row.day_units } : null };
    }
    return {};
  });
}

const T0 = "2026-11-03T20:00:00.000Z";
const T1 = "2026-11-03T20:01:00.000Z";

describe("D1 AI quota (fail-closed)", () => {
  it("allows within the minute cap and blocks past 30 units/minute", async () => {
    const db = quotaDb(new Map());
    expect(await consumeAiQuota(db, "teacher-1", 5, T0)).toBe(true);
    expect(await consumeAiQuota(db, "teacher-1", 20, T0)).toBe(true);
    expect(await consumeAiQuota(db, "teacher-1", 5, T0)).toBe(true);
    expect(await consumeAiQuota(db, "teacher-1", 1, T0)).toBe(false);
    expect((await getAiQuotaUsage(db, "teacher-1"))?.minuteUnits).toBe(30);
  });

  it("resets the minute window but keeps the day total", async () => {
    const db = quotaDb(new Map());
    expect(await consumeAiQuota(db, "teacher-1", 20, T0)).toBe(true);
    expect(await consumeAiQuota(db, "teacher-1", 20, T1)).toBe(true);
    expect((await getAiQuotaUsage(db, "teacher-1"))?.dayUnits).toBe(40);
    expect((await getAiQuotaUsage(db, "teacher-1"))?.minuteUnits).toBe(20);
  });

  it("blocks past 500 units/day", async () => {
    const db = quotaDb(new Map());
    for (let i = 0; i < 25; i++) {
      expect(
        await consumeAiQuota(
          db,
          "teacher-1",
          20,
          `2026-11-03T20:${String(i).padStart(2, "0")}:00.000Z`,
        ),
      ).toBe(true);
    }
    expect(await consumeAiQuota(db, "teacher-1", 1, "2026-11-03T21:00:00.000Z")).toBe(false);
  });

  it("rejects invalid unit counts and fails closed on DB errors", async () => {
    const db = quotaDb(new Map());
    expect(await consumeAiQuota(db, "teacher-1", 0, T0)).toBe(false);
    expect(await consumeAiQuota(db, "teacher-1", 21, T0)).toBe(false);
    expect(await consumeAiQuota(db, "teacher-1", -3, T0)).toBe(false);
    const throwing = fakeDb(() => {
      throw new Error("boom");
    });
    expect(await consumeAiQuota(throwing, "teacher-1", 1, T0)).toBe(false);
  });
});

// ------------------------------------------------------------- whatsapp
type ClaimRow = { claimed_at: string; completed: number };

function whatsappDb() {
  const owners = new Map<string, string>([
    ["sub-1", "teacher-1"],
    ["sub-2", "teacher-1"],
  ]);
  // submissionId -> last audited status; only 'sent' blocks a new claim.
  const sends = new Map<string, string>();
  const claims = new Map<string, ClaimRow>();
  const db = fakeDb((sql, params) => {
    if (sql.includes("FROM submissions s") && sql.includes("JOIN assessments")) {
      const teacher = owners.get(params[0] as string);
      return { first: teacher ? { teacher_id: teacher } : null };
    }
    if (sql.includes("FROM whatsapp_sends") && sql.includes("status = 'sent'")) {
      return { first: sends.get(params[0] as string) === "sent" ? { id: "send-1" } : null };
    }
    if (sql.includes("INSERT INTO whatsapp_send_claims") && sql.includes("ON CONFLICT")) {
      const [subId, now, cutoff] = params as [string, string, string | undefined];
      const existing = claims.get(subId);
      if (!existing) {
        // Backfill branch (completed=1) has no cutoff param.
        claims.set(subId, { claimed_at: now, completed: cutoff === undefined ? 1 : 0 });
        return { changes: 1 };
      }
      if (cutoff === undefined) {
        existing.completed = 1;
        return { changes: 1 };
      }
      if (existing.completed === 0 && existing.claimed_at < cutoff) {
        existing.claimed_at = now;
        return { changes: 1 };
      }
      return { changes: 0 };
    }
    if (sql.includes("FROM whatsapp_send_claims") && sql.includes("completed = 0")) {
      const c = claims.get(params[0] as string);
      return { first: c && c.completed === 0 ? { submission_id: params[0] } : null };
    }
    if (sql.includes("INSERT INTO whatsapp_sends")) {
      sends.set(params[1] as string, params[3] as string);
      return { changes: 1 };
    }
    if (sql.includes("UPDATE whatsapp_send_claims")) {
      const c = claims.get(params[1] as string);
      if (c) {
        c.completed = 1;
        c.claimed_at = params[0] as string;
      }
      return { changes: 1 };
    }
    if (sql.includes("DELETE FROM whatsapp_send_claims")) {
      claims.delete(params[0] as string);
      return { changes: 1 };
    }
    return {};
  });
  return { db, sends, claims };
}

describe("D1 WhatsApp claim (claim-or-fail, sending stays OFF)", () => {
  it("grants the first claim and fails a double claim inside 15 minutes", async () => {
    const { db } = whatsappDb();
    expect(await claimWhatsappSend(db, "teacher-1", "sub-1", T0)).toBe(true);
    expect(await claimWhatsappSend(db, "teacher-1", "sub-1", "2026-11-03T20:01:00.000Z")).toBe(
      false,
    );
  });

  it("allows a re-claim after the 15-minute window", async () => {
    const { db } = whatsappDb();
    expect(await claimWhatsappSend(db, "teacher-1", "sub-1", T0)).toBe(true);
    expect(await claimWhatsappSend(db, "teacher-1", "sub-1", "2026-11-03T20:16:00.000Z")).toBe(
      true,
    );
  });

  it("refuses a claim for another teacher's submission", async () => {
    const { db } = whatsappDb();
    await expect(claimWhatsappSend(db, "teacher-2", "sub-1", T0)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses a claim for an already-sent submission, and finish releases a retryable claim", async () => {
    const { db, sends, claims } = whatsappDb();
    expect(await claimWhatsappSend(db, "teacher-1", "sub-2", T0)).toBe(true);
    expect(
      await finishWhatsappSend(db, "teacher-1", "sub-2", { status: "sent", trigger: "manual" }, T0),
    ).toBe(true);
    expect(sends.has("sub-2")).toBe(true);
    expect(await claimWhatsappSend(db, "teacher-1", "sub-2", "2026-11-03T20:05:00.000Z")).toBe(
      false,
    );
    expect(
      await finishWhatsappSend(db, "teacher-1", "sub-2", { status: "sent", trigger: "manual" }, T0),
    ).toBe(false);
    void claims;
  });

  it("a retryable failed finish deletes the claim so a later claim succeeds", async () => {
    const { db } = whatsappDb();
    expect(await claimWhatsappSend(db, "teacher-1", "sub-1", T0)).toBe(true);
    expect(
      await finishWhatsappSend(
        db,
        "teacher-1",
        "sub-1",
        { status: "failed", trigger: "auto", retryable: true },
        T0,
      ),
    ).toBe(true);
    expect(await claimWhatsappSend(db, "teacher-1", "sub-1", "2026-11-03T20:02:00.000Z")).toBe(
      true,
    );
  });
});
