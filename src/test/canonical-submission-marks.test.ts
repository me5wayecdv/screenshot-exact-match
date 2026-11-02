import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20261102050438_canonical_submission_marks.sql"),
  "utf8",
);
const aiGrade = readFileSync(resolve(root, "src/server/ai-grade.ts"), "utf8");
const tutor = readFileSync(resolve(root, "src/server/tutor.ts"), "utf8");
const handwritten = readFileSync(resolve(root, "src/server/handwritten.ts"), "utf8");
const sourceOcr = readFileSync(resolve(root, "src/server/source-ocr.ts"), "utf8");
const paperMatching = readFileSync(resolve(root, "src/server/paper-matching.ts"), "utf8");

describe("canonical grading and bounded AI inputs", () => {
  it("validates answer marks against the question in the submission assessment", () => {
    expect(migration).toMatch(
      /select q\.marks into v_max_marks[\s\S]*?q\.id = an\.question_id and q\.assessment_id = s\.assessment_id/i,
    );
    expect(migration).toMatch(/max_marks = v_max_marks/i);
    expect(migration).toMatch(
      /join public\.questions q on q\.id = valid_answer\.question_id[\s\S]*?q\.assessment_id = s\.assessment_id/i,
    );
  });

  it("derives released totals from assessment questions, not arbitrary answer rows", () => {
    expect(migration).toMatch(
      /select coalesce\(sum\(an\.final_score\), 0\), coalesce\(sum\(q\.marks\), 0\)[\s\S]*?from public\.questions q[\s\S]*?left join public\.answers an on an\.question_id = q\.id and an\.submission_id = _sub[\s\S]*?where q\.assessment_id = s\.assessment_id/i,
    );
    expect(migration).not.toMatch(
      /select coalesce\(sum\(final_score\), 0\), coalesce\(sum\(max_marks\), 0\)[\s\S]*?from public\.answers/i,
    );
  });

  it("caps each accepted alternative and their aggregate before the AI call", () => {
    expect(aiGrade).toMatch(/rawAlternatives\.length > 50/);
    expect(aiGrade).toMatch(/rawAlternatives\.some\([\s\S]*?alternative\.length > 2000/);
    expect(aiGrade).toMatch(/alternativesChars > 20000/);
  });

  it("bounds tutor answer and feedback text before constructing provider prompts", () => {
    expect(tutor).toMatch(/studentAnswer\.length > 20000 \|\| teacherFeedback\.length > 5000/);
    expect(tutor).toMatch(/questionId\.length > 100/);
    expect(tutor).toMatch(/newAnswer\.length > 5000/);
  });

  it("caps individual vision inputs and aggregate multi-image batches", () => {
    for (const server of [handwritten, sourceOcr, paperMatching]) {
      expect(server).toMatch(/const MAX_DATA_URL_CHARS = 4_000_000/);
    }
    expect(sourceOcr).toMatch(/totalImageChars > MAX_BATCH_DATA_URL_CHARS/);
    expect(paperMatching).toMatch(/totalImageChars > MAX_BATCH_DATA_URL_CHARS/);
  });
});
