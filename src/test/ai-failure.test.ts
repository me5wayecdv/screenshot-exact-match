import { describe, expect, it } from "vitest";

import { classifyAiHttpStatus, describeProviderError, describeThrown } from "@/lib/ai-failure";

describe("classifyAiHttpStatus", () => {
  it("separates a rejected key from a quota limit and a bad request", () => {
    expect(classifyAiHttpStatus(401)).toBe("AI_AUTH");
    expect(classifyAiHttpStatus(403)).toBe("AI_AUTH");
    expect(classifyAiHttpStatus(429)).toBe("AI_RATE_LIMIT");
    expect(classifyAiHttpStatus(400)).toBe("AI_BAD_REQUEST");
    expect(classifyAiHttpStatus(404)).toBe("AI_BAD_REQUEST");
    expect(classifyAiHttpStatus(500)).toBe("AI_UPSTREAM");
    expect(classifyAiHttpStatus(503)).toBe("AI_UPSTREAM");
  });
});

describe("describeProviderError", () => {
  it("reads the Cloudflare { errors: [{ message }] } shape", () => {
    expect(
      describeProviderError({ errors: [{ message: "Invalid model name" }], success: false }),
    ).toBe("Invalid model name");
  });

  it("reads the OpenAI { error: { message } } shape", () => {
    expect(describeProviderError({ error: { message: "quota exceeded" } })).toBe("quota exceeded");
  });

  it("caps the message and never throws on junk", () => {
    expect(describeProviderError("x".repeat(500)).endsWith("…")).toBe(true);
    expect(describeProviderError(null)).toBe("");
    expect(describeProviderError(42)).toBe("");
  });
});

describe("describeThrown", () => {
  it("keeps the message and drops a redundant Error prefix", () => {
    expect(describeThrown(new Error("boom"))).toBe("boom");
    expect(describeThrown(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeThrown("plain")).toBe("plain");
  });
});
