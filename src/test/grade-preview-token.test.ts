// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  signGradePreview,
  verifyGradePreview,
  type GradePreview,
} from "@/server/grade-preview-token";
const testKey = "synthetic-test-key-only-000000000000000000000000";
function payload(): GradePreview {
  return {
    v: 1,
    purpose: "qemmini.handwritten.preview",
    id: crypto.randomUUID(),
    fingerprint: "teacher-answer-criteria-hash",
    expiresAt: Date.now() + 30 * 60000,
    suggestion: { suggestedScore: 8, feedback: "Reviewed", confidence: "high" },
    model: "test",
  };
}
beforeEach(() => {
  process.env["GRADE_PREVIEW_SIGNING_KEY"] = testKey;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["GRADE_PREVIEW_SIGNING_KEY"];
});
describe("Purpose-specific stateless grade previews", () => {
  it("round-trips across calls, requires no bucket and hides answer/criteria", async () => {
    const data = payload();
    const token = await signGradePreview(data);
    expect(await verifyGradePreview(token)).toEqual(data);
    expect(token).not.toContain("student answer");
  });
  it("rejects changing the score even with a preserved signature", async () => {
    const token = await signGradePreview(payload());
    const [body, sig] = token.split(".");
    const data = JSON.parse(Buffer.from(body!, "base64url").toString());
    data.suggestion.suggestedScore = 10;
    const forged = Buffer.from(JSON.stringify(data)).toString("base64url") + "." + sig;
    await expect(verifyGradePreview(forged)).rejects.toThrow();
  });
  it("rejects other purpose, expiry, distant expiry and wrong signing key", async () => {
    const data = payload();
    await expect(
      verifyGradePreview(
        await signGradePreview({ ...data, purpose: "other" as GradePreview["purpose"] }),
      ),
    ).rejects.toThrow();
    await expect(
      verifyGradePreview(await signGradePreview({ ...data, expiresAt: Date.now() - 1 })),
    ).rejects.toThrow();
    await expect(
      verifyGradePreview(await signGradePreview({ ...data, expiresAt: Date.now() + 60 * 60000 })),
    ).rejects.toThrow();
    const token = await signGradePreview(data);
    process.env["GRADE_PREVIEW_SIGNING_KEY"] = testKey + "different";
    await expect(verifyGradePreview(token)).rejects.toThrow();
  });
  it("fails closed without a dedicated key", async () => {
    delete process.env["GRADE_PREVIEW_SIGNING_KEY"];
    await expect(signGradePreview(payload())).rejects.toThrow("PREVIEW_SIGNING_NOT_CONFIGURED");
  });
});
