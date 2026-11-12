/**
 * Tests for AI-F6: the text AI path (suggestGradeWithAi, Llama 3.3-70b via
 * Workers AI) must share the classifyAiHttpStatus taxonomy from
 * src/lib/ai-failure.ts instead of mapping every non-OK response to a
 * generic AI_ERROR, and must retry transient 429/503 responses with a
 * small fixed bound.
 *
 * - 429/503: retried, at most 2 retries (3 attempts total), then the error
 *   surfaces with the shared code (AI_RATE_LIMIT for 429).
 * - 400/401/403/404/500: no retry, surfaced with the shared code.
 * - Empty reply -> AI_EMPTY_REPLY; aborted request -> AI_TIMEOUT;
 *   network failure -> AI_UPSTREAM.
 * - Parse failures stay AI_ERROR (pinned by the AI-F3 test in
 *   ai-grading-prompt-injection.test.ts: a non-finite/missing score is
 *   still rejected, and clamping to [0, maxMarks] still applies).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { suggestGradeWithAi } from "@/server/ai-client";

const gradingInput = {
  questionPrompt: "ما عاصمة مصر؟",
  rubric: "",
  acceptedAlternatives: [],
  studentAnswer: "القاهرة",
  maxMarks: 10,
};

function mockFetchSequence(responses: Array<{ status: number; content?: string }>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No mocked AI response remains.");
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => ({
        choices: [{ message: { content: next.content ?? "" } }],
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockFailingFetch(error: Error) {
  const fetchMock = vi.fn(async () => {
    throw error;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("suggestGradeWithAi retry + classification (AI-F6)", () => {
  beforeEach(() => {
    process.env["AI_BASE_URL"] = "http://localhost:11434/v1";
    process.env["AI_MODEL"] = "test-model";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["AI_BASE_URL"];
    delete process.env["AI_MODEL"];
    delete process.env["AI_API_KEY"];
  });

  it("retries a 429 once it clears and succeeds", async () => {
    const fetchMock = mockFetchSequence([
      { status: 429 },
      {
        status: 200,
        content: '{"suggested_score": 8, "feedback": "جيد", "confidence": "high"}',
      },
    ]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.suggestion.suggestedScore).toBe(8);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("retries a 503 and succeeds", async () => {
    const fetchMock = mockFetchSequence([
      { status: 503 },
      {
        status: 200,
        content: '{"suggested_score": 6, "feedback": "مقبول", "confidence": "medium"}',
      },
    ]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("bounds 429 retries at 2 and surfaces AI_RATE_LIMIT", async () => {
    const fetchMock = mockFetchSequence([{ status: 429 }, { status: 429 }, { status: 429 }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_RATE_LIMIT");
    // Initial attempt + exactly 2 retries, no more.
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  it("bounds 503 retries at 2 and surfaces AI_UPSTREAM", async () => {
    const fetchMock = mockFetchSequence([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_UPSTREAM");
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  it("does not retry a 400 and classifies it AI_BAD_REQUEST", async () => {
    const fetchMock = mockFetchSequence([{ status: 400 }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_BAD_REQUEST");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("does not retry a 401 and classifies it AI_AUTH", async () => {
    const fetchMock = mockFetchSequence([{ status: 401 }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_AUTH");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("does not retry a 403 and classifies it AI_AUTH", async () => {
    const fetchMock = mockFetchSequence([{ status: 403 }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_AUTH");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("does not retry a 404 and classifies it AI_BAD_REQUEST", async () => {
    const fetchMock = mockFetchSequence([{ status: 404 }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_BAD_REQUEST");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("does not retry a 500 and classifies it AI_UPSTREAM", async () => {
    const fetchMock = mockFetchSequence([{ status: 500 }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_UPSTREAM");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("maps an empty reply to AI_EMPTY_REPLY", async () => {
    mockFetchSequence([{ status: 200, content: "" }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_EMPTY_REPLY");
  });

  it("maps an aborted request to AI_TIMEOUT", async () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    mockFailingFetch(aborted);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_TIMEOUT");
  });

  it("maps a network failure to AI_UPSTREAM without retrying", async () => {
    const fetchMock = mockFailingFetch(new Error("fetch failed"));
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_UPSTREAM");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("keeps the AI-F3 contract: a missing score is still AI_ERROR, clamping still applies", async () => {
    mockFetchSequence([{ status: 200, content: '{"feedback": "جيد"}' }]);
    const res = await suggestGradeWithAi(gradingInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("AI_ERROR");

    mockFetchSequence([{ status: 200, content: '{"suggested_score": 99, "feedback": "جيد"}' }]);
    const res2 = await suggestGradeWithAi(gradingInput);
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.suggestion.suggestedScore).toBe(10);
  });
});
