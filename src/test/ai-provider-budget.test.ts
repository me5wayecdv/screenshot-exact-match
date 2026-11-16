// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { auditDb } from "./audit-sqlite-helper";
import {
  aiProviderFetch,
  readAiProviderPolicy,
  reserveProviderAttempt,
} from "@/server/ai-provider-fetch";
import { setD1Binding } from "@/server/d1";
import { suggestGradeWithAi } from "@/server/ai-client";

const request = {
  questionPrompt: "Capital?",
  rubric: "",
  acceptedAlternatives: [],
  studentAnswer: "Cairo",
  maxMarks: 10,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setD1Binding(null);
});
function localConfig() {
  vi.stubEnv("AI_BASE_URL", "http://localhost:11434/v1");
  vi.stubEnv("AI_MODEL", "test");
}
describe("Provider attempt safety and cost measurement", () => {
  it("preserves current service by default and rejects malformed policy", () => {
    expect(readAiProviderPolicy({})).toEqual({ enabled: true, dailyRequests: null });
    for (const raw of ["-1", "1.2", "NaN", "5x", "Infinity", "9007199254740992"]) {
      expect(() => readAiProviderPolicy({ AI_PROVIDER_DAILY_REQUEST_LIMIT: raw })).toThrow();
    }
    expect(() => readAiProviderPolicy({ AI_REQUESTS_ENABLED: "flase" })).toThrow();
    expect(readAiProviderPolicy({ AI_PROVIDER_DAILY_REQUEST_LIMIT: "0" }).dailyRequests).toBe(0);
  });
  it("uses actual SQLite to bound concurrent reservations, rollover and migration replay", async () => {
    const { db, sql } = auditDb();
    const migration = readFileSync("schema/migrations/20261116_ai_provider_budget.sql", "utf8");
    sql.exec(migration);
    sql.exec(migration);
    const date = new Date("2026-11-16T12:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 30 }, () => reserveProviderAttempt(db, 7, date)),
    );
    expect(results.filter(Boolean)).toHaveLength(7);
    expect(
      sql.prepare("SELECT request_count FROM ai_provider_daily_budget").get()?.["request_count"],
    ).toBe(7);
    expect(await reserveProviderAttempt(db, 7, new Date("2026-11-17T00:00:00Z"))).toBe(true);
    expect(await reserveProviderAttempt(db, 0, date)).toBe(false);
    sql.close();
  });
  it("kill switch and zero budget perform no network request or DB access", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    vi.stubEnv("AI_REQUESTS_ENABLED", "false");
    await expect(aiProviderFetch("https://example.invalid", {})).rejects.toThrow(
      "AI_PROVIDER_PAUSED",
    );
    vi.stubEnv("AI_REQUESTS_ENABLED", "true");
    vi.stubEnv("AI_PROVIDER_DAILY_REQUEST_LIMIT", "0");
    await expect(aiProviderFetch("https://example.invalid", {})).rejects.toThrow(
      "AI_PROVIDER_BUDGET_EXCEEDED",
    );
    expect(network).not.toHaveBeenCalled();
  });
  it("fails closed when the budget table is missing", async () => {
    const { db, sql } = auditDb();
    sql.exec("DROP TABLE ai_provider_daily_budget");
    setD1Binding(db);
    vi.stubEnv("AI_PROVIDER_DAILY_REQUEST_LIMIT", "4");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(aiProviderFetch("https://example.invalid", {})).rejects.toThrow(
      "AI_PROVIDER_BUDGET_EXCEEDED",
    );
    expect(network).not.toHaveBeenCalled();
    sql.close();
  });
  it("counts a failed network attempt permanently, even when product quota would refund", async () => {
    const { db, sql } = auditDb();
    setD1Binding(db);
    vi.stubEnv("AI_PROVIDER_DAILY_REQUEST_LIMIT", "1");
    const network = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", network);
    await expect(aiProviderFetch("https://example.invalid", {})).rejects.toThrow("network");
    await expect(aiProviderFetch("https://example.invalid", {})).rejects.toThrow(
      "AI_PROVIDER_BUDGET_EXCEEDED",
    );
    expect(network).toHaveBeenCalledTimes(1);
    sql.close();
  });
  it("retries must each reserve budget and never exceed the configured bound", async () => {
    const { db, sql } = auditDb();
    setD1Binding(db);
    localConfig();
    vi.stubEnv("AI_PROVIDER_DAILY_REQUEST_LIMIT", "1");
    const network = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", network);
    expect((await suggestGradeWithAi(request)).ok).toBe(false);
    expect(network).toHaveBeenCalledTimes(1);
    sql.close();
  });
  it.each(["", "bad json", '{"suggested_score":null}'])(
    "measures paid unusable reply %j and caps grading output",
    async (content) => {
      localConfig();
      const usage = vi.fn().mockResolvedValue(undefined);
      const network = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 42, completion_tokens: 12 },
          }),
        ),
      );
      vi.stubGlobal("fetch", network);
      expect((await suggestGradeWithAi(request, usage)).ok).toBe(false);
      expect(usage).toHaveBeenCalledWith(
        expect.objectContaining({ usage: { inputTokens: 42, outputTokens: 12 } }),
      );
      expect(JSON.parse(network.mock.calls[0]![1].body).max_tokens).toBe(1200);
    },
  );
  it("measurement failure never discards a valid suggestion", async () => {
    localConfig();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ choices: [{ message: { content: '{"suggested_score":8}' } }] }),
          ),
        ),
    );
    expect(
      (
        await suggestGradeWithAi(request, async () => {
          throw new Error("sink");
        })
      ).ok,
    ).toBe(true);
  });
  it("all eight AI modules use the common gate, with no direct provider fetch bypass", () => {
    for (const file of [
      "src/server/ai-client.ts",
      "src/server/handwritten.ts",
      "src/server/source-ocr.ts",
      "src/server/paper-matching.ts",
      "src/server/tutor.ts",
      "src/server/teacher-assistant.ts",
      "src/server/lesson-explain.ts",
      "src/lib/generate-assessment.ts",
    ]) {
      const code = readFileSync(file, "utf8");
      expect(code).toContain("await aiProviderFetch(");
      expect(code).not.toMatch(/\bfetch\s*\(/);
    }
  });
  it.each([2, 3])("reserves every retry up to a budget of %i", async (limit) => {
    const { db, sql } = auditDb();
    setD1Binding(db);
    localConfig();
    vi.stubEnv("AI_PROVIDER_DAILY_REQUEST_LIMIT", String(limit));
    const network = vi.fn().mockImplementation(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", network);
    expect((await suggestGradeWithAi(request)).ok).toBe(false);
    expect(network).toHaveBeenCalledTimes(limit);
    expect(
      sql.prepare("SELECT request_count FROM ai_provider_daily_budget").get()!["request_count"],
    ).toBe(limit);
    sql.close();
  });
  it("opt-in ledger records unknown usage, network failures and paid malformed responses without content", async () => {
    const { db, sql } = auditDb();
    setD1Binding(db);
    vi.stubEnv("AI_ATTEMPT_LOG_ENABLED", "true");
    const network = vi
      .fn()
      .mockResolvedValueOnce(new Response("not-json"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            usage: { prompt_tokens: 20, completion_tokens: 4 },
            choices: [{ message: { content: "private answer" } }],
          }),
        ),
      )
      .mockRejectedValueOnce(new Error("secret body"));
    vi.stubGlobal("fetch", network);
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "test", messages: [{ content: "private prompt" }] }),
    };
    await aiProviderFetch("https://example.invalid/chat/completions", init);
    const response = await aiProviderFetch("https://example.invalid/chat/completions", init);
    expect((await response.json()).choices[0].message.content).toBe("private answer");
    await expect(
      aiProviderFetch("https://example.invalid/chat/completions", init),
    ).rejects.toThrow();
    const rows = sql.prepare("SELECT * FROM ai_provider_attempts ORDER BY rowid").all();
    expect(rows).toHaveLength(3);
    expect(rows[0]!["input_tokens"]).toBe(null);
    expect(rows[1]!["input_tokens"]).toBe(20);
    expect(rows[2]!["outcome"]).toBe("network_error");
    expect(JSON.stringify(rows)).not.toMatch(/private|secret/);
    sql.close();
  });
});
