/**
 * Tests for the Phase 2c D1 port of src/server/paper-matching.ts and
 * the handwritten route's re-pointing to it. Source-level assertions
 * (the established pattern in this repo, e.g. security-hardening
 * and canonical-submission-marks tests): the match handler resolves
 * its session from the HttpOnly cookie, never accepts a client
 * access token, never touches Supabase, and never selects
 * question_keys.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const paperMatching = readFileSync(resolve(root, "src/server/paper-matching.ts"), "utf8");
const handwrittenRoute = readFileSync(
  resolve(root, "src/routes/_authenticated/handwritten.tsx"),
  "utf8",
);

describe("paper-matching D1 port", () => {
  it("resolves the session from the HttpOnly cookie, not a client token", () => {
    expect(paperMatching).toMatch(/requireCloudflareAuth/);
    expect(paperMatching).toMatch(/\.middleware\(\[requireCloudflareAuth\]\)/);
    expect(paperMatching).not.toMatch(/accessToken/);
    expect(paperMatching).not.toMatch(/getAccessToken/);
  });

  it("has no Supabase references left", () => {
    expect(paperMatching).not.toMatch(/supabase/i);
    expect(paperMatching).not.toMatch(/createClient/);
    expect(paperMatching).not.toMatch(/createUsageClient/);
    expect(paperMatching).not.toMatch(/consumeAiRateQuota/);
  });

  it("uses D1 quota and usage logging", () => {
    expect(paperMatching).toMatch(/consumeAiQuota/);
    expect(paperMatching).toMatch(/logAiUsageEvent/);
    expect(paperMatching).toMatch(/from "@\/server\/d1-quota"/);
  });

  it("checks teacher/admin role and assessment ownership in D1", () => {
    expect(paperMatching).toMatch(/SELECT teacher_id FROM assessments WHERE id = \?/);
    expect(paperMatching).toMatch(
      /TEACHER_ROLES = new Set\(\["school_teacher", "tutor", "admin"\]\)/,
    );
    expect(paperMatching).toMatch(/This assessment does not belong to the caller/);
  });

  it("never selects question_keys; questions are id/prompt/position only", () => {
    // The word appears only in comments stating it is never selected;
    // assert on SQL, not on prose.
    expect(paperMatching).not.toMatch(/SELECT[^;]*question_keys/);
    expect(paperMatching).not.toMatch(/FROM question_keys/);
    expect(paperMatching).toMatch(
      /SELECT id, prompt, position FROM questions WHERE assessment_id = \? ORDER BY position/,
    );
  });

  it("keeps the batch failure contract (1–10 pages, first failure stops)", () => {
    expect(paperMatching).toMatch(/MAX_PAGES = 10/);
    expect(paperMatching).toMatch(/pageIndex: i/);
  });
});

describe("handwritten route re-pointing", () => {
  it("passes no access token to matchPaperPages and imports no Supabase client", () => {
    expect(handwrittenRoute).not.toMatch(/integrations\/supabase\/client/);
    expect(handwrittenRoute).not.toMatch(/getAccessToken/);
    expect(handwrittenRoute).not.toMatch(/accessToken/);
    expect(handwrittenRoute).toMatch(/matchPaperPages\(\{\s*data: \{\s*assessmentId,/);
  });
});
