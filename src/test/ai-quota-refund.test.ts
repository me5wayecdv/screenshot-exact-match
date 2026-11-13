// @vitest-environment node
/**
 * Tests for AI-F5: quota consumed before an AI call must be refunded when
 * the AI call fails (or the flow aborts before the AI result is used).
 *
 * - refundAiQuota (src/server/d1-quota.ts) reverses a prior consumeAiQuota
 *   increment: minute/day counters go back down, floored at 0, and only
 *   inside the window the consume landed in (a refund after the minute
 *   rolled over must not debit the new window's units).
 * - The refund is best-effort: it never throws and returns false when
 *   there is nothing to refund or the database is unavailable.
 * - A second refund of the same consume can never drive the counters
 *   below zero (call sites refund at most once per consume; the function
 *   itself floors at 0, so even a repeated call is harmless).
 *
 * Runs against a real in-memory SQLite database (node:sqlite) behind a
 * minimal D1Database adapter, so the exact SQL the server code issues is
 * what gets exercised.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { consumeAiQuota, getAiQuotaUsage, refundAiQuota } from "@/server/d1-quota";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";

/** Minimal D1Database adapter over an in-memory SQLite database. */
function sqliteD1(db: DatabaseSync): D1Database {
  const prepare = (sql: string): D1Statement => {
    const stmt = db.prepare(sql);
    let params: SQLInputValue[] = [];
    const s: D1Statement = {
      bind(...p: unknown[]) {
        params = p as SQLInputValue[];
        return s;
      },
      async first<T>() {
        const row = stmt.get(...params) as T | undefined;
        return row ?? null;
      },
      async all<T>() {
        return { results: stmt.all(...params) as T[] };
      },
      async run() {
        const info = stmt.run(...params);
        return { meta: { changes: info.changes } };
      },
    };
    return s;
  };
  return {
    prepare,
    async batch(statements: D1Statement[]) {
      const out: unknown[] = [];
      for (const st of statements) out.push(await st.run());
      return out;
    },
  };
}

function freshDb(): { db: DatabaseSync; d1: D1Database } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE ai_rate_limits (
      user_id TEXT PRIMARY KEY,
      minute_started_at TEXT NOT NULL,
      minute_units INTEGER NOT NULL DEFAULT 0 CHECK (minute_units >= 0),
      day_started_on TEXT NOT NULL,
      day_units INTEGER NOT NULL DEFAULT 0 CHECK (day_units >= 0),
      updated_at TEXT NOT NULL
    );
  `);
  return { db, d1: sqliteD1(db) };
}

const NOW = "2026-11-12T19:00:00.000Z";

describe("refundAiQuota (AI-F5)", () => {
  it("restores the consumed units on AI failure", async () => {
    const { d1 } = freshDb();
    expect(await consumeAiQuota(d1, "teacher-1", 3, NOW)).toBe(true);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 3, dayUnits: 3 });
    expect(await refundAiQuota(d1, "teacher-1", 3, NOW)).toBe(true);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 0, dayUnits: 0 });
  });

  it("refunds only the requested amount (partial refund)", async () => {
    const { d1 } = freshDb();
    await consumeAiQuota(d1, "teacher-1", 5, NOW);
    await refundAiQuota(d1, "teacher-1", 2, NOW);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 3, dayUnits: 3 });
  });

  it("never drives the counters below zero on a repeated refund", async () => {
    const { d1 } = freshDb();
    await consumeAiQuota(d1, "teacher-1", 1, NOW);
    expect(await refundAiQuota(d1, "teacher-1", 1, NOW)).toBe(true);
    // A second refund of the same consume must not double-refund.
    await refundAiQuota(d1, "teacher-1", 1, NOW);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 0, dayUnits: 0 });
  });

  it("refunding more than was consumed floors at zero", async () => {
    const { d1 } = freshDb();
    await consumeAiQuota(d1, "teacher-1", 1, NOW);
    await refundAiQuota(d1, "teacher-1", 20, NOW);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 0, dayUnits: 0 });
  });

  it("returns false when there is no quota row to refund", async () => {
    const { d1 } = freshDb();
    expect(await refundAiQuota(d1, "nobody", 1, NOW)).toBe(false);
  });

  it("rejects invalid units without touching the database", async () => {
    const { d1 } = freshDb();
    for (const units of [0, -1, 1.5, 21, Number.NaN]) {
      await expect(refundAiQuota(d1, "teacher-1", units, NOW)).resolves.toBe(false);
    }
    expect(await getAiQuotaUsage(d1, "teacher-1")).toBeNull();
  });

  it("never throws when the database is unavailable", async () => {
    const broken = {
      prepare() {
        throw new Error("offline");
      },
    } as unknown as D1Database;
    await expect(refundAiQuota(broken, "teacher-1", 1, NOW)).resolves.toBe(false);
  });

  it("does not debit the new minute window when the minute rolled over", async () => {
    const { d1 } = freshDb();
    await consumeAiQuota(d1, "teacher-1", 5, NOW);
    // One minute later: the day window is the same, the minute window is new.
    const later = "2026-11-12T19:01:00.000Z";
    await refundAiQuota(d1, "teacher-1", 5, later);
    // Day units are refunded; the stale minute value is left alone (the
    // next consume in the new window resets it via its own CASE).
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 5, dayUnits: 0 });
    // And the next consume in the new window starts from a clean minute.
    expect(await consumeAiQuota(d1, "teacher-1", 2, later)).toBe(true);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 2, dayUnits: 2 });
  });

  it("a successful AI call keeps the consumed unit (no refund)", async () => {
    // Call-site contract, simulated: consume -> AI succeeds -> no refund.
    const { d1 } = freshDb();
    expect(await consumeAiQuota(d1, "teacher-1", 1, NOW)).toBe(true);
    const aiSucceeded = true;
    if (!aiSucceeded) await refundAiQuota(d1, "teacher-1", 1, NOW);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 1, dayUnits: 1 });
  });

  it("a failed AI call gives the unit back (no refund on success, refund on failure)", async () => {
    // Call-site contract, simulated: consume -> AI fails -> refund once.
    const { d1 } = freshDb();
    expect(await consumeAiQuota(d1, "teacher-1", 1, NOW)).toBe(true);
    const aiSucceeded = false;
    if (!aiSucceeded) await refundAiQuota(d1, "teacher-1", 1, NOW);
    expect(await getAiQuotaUsage(d1, "teacher-1")).toEqual({ minuteUnits: 0, dayUnits: 0 });
  });
});
