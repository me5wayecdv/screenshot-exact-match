import { afterEach, describe, expect, it, vi } from "vitest";
import { callVisionOcr, type VisionConfig } from "@/server/handwritten";
const cf = "https://api.cloudflare.com/client/v4/accounts/synthetic/v1";
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["VISION_PROVIDER"];
  delete process.env["GEMINI_API_KEY"];
});
describe("Paper reading roles reach each vision adapter", () => {
  it.each([
    ["OpenAI compatible", "http://localhost:11434/v1", "vision", "compat"],
    ["Cloudflare native", cf, "@cf/meta/vision", "native"],
    ["LLaVA", cf, "@cf/llava/vision", "description"],
    ["Moondream", cf, "@cf/moondream/vision", "description"],
  ])("keeps bubble reference instructions on %s", async (_name, baseUrl, model, format) => {
    const mock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        format === "compat"
          ? { choices: [{ message: { content: "1: B" } }] }
          : {
              success: true,
              result: format === "native" ? { response: "1: B" } : { description: "1: B" },
            },
    }));
    vi.stubGlobal("fetch", mock);
    const config: VisionConfig = {
      baseUrl: baseUrl!,
      model: model!,
      apiKey: "synthetic",
      visionModelExplicit: true,
    };
    const result = await callVisionOcr(config, "data:image/png;base64,aW1hZ2U=", {
      role: "reference",
      kind: "bubble",
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(
      (mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(JSON.stringify(body)).toContain("MODEL ANSWER REFERENCE");
    expect(JSON.stringify(body)).toContain("shaded/marked bubbles");
    expect(JSON.stringify(body)).toContain("[multiple]");
  });
  it("sends the student role to Gemini rather than the default text-only transcription prompt", async () => {
    process.env["VISION_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "synthetic";
    const mock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "1: C" }] } }] }),
    }));
    vi.stubGlobal("fetch", mock);
    await callVisionOcr(
      {
        baseUrl: "http://localhost:11434/v1",
        model: "vision",
        apiKey: "synthetic",
        visionModelExplicit: true,
      },
      "data:image/png;base64,aW1hZ2U=",
      { role: "student", kind: "bubble" },
    );
    const body = JSON.parse(
      (mock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.contents[0].parts[0].text).toContain("STUDENT ANSWER PAPER");
    expect(body.contents[0].parts[0].text).toContain("shaded/marked bubbles");
  });
});
