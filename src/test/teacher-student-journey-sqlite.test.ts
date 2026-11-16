// @vitest-environment node
import { expect, it } from "vitest";
import { auditDb } from "./audit-sqlite-helper";
import { createD1AuthStore } from "@/server/d1-auth-store";
import { signUp, signIn } from "@/lib/cloudflare-auth";
import {
  createAssessment,
  addQuestion,
  updateQuestion,
  setAssessmentStatus,
  joinTeacher,
  getStudentHome,
} from "@/server/d1-assessments";
import { decideEnrollment } from "@/server/d1-students";
import { getTakeData, startAttempt, saveDraft, submitAttempt } from "@/server/d1-take";
import { reviewAnswer, releaseSubmission } from "@/server/d1-grading";

it("actual SQL journey: signup approval, join, exam, draft resume, submit, teacher review and released result", async () => {
  const { db, sql } = auditDb();
  const store = createD1AuthStore(db);
  const t = await signUp(store, {
    email: "journey-teacher@example.invalid",
    password: "test-only-password",
    fullName: "Synthetic teacher",
    role: "school_teacher",
    teacherPhone: "01000000000",
    iterations: 1000,
  });
  const s = await signUp(store, {
    email: "journey-student@example.invalid",
    password: "test-only-password",
    fullName: "Synthetic student",
    role: "student",
    parentPhone: "01000000000",
    iterations: 1000,
  });
  expect(t.status).toBe("pending");
  expect(s.status).toBe("pending");
  await expect(
    signIn(store, { email: "journey-student@example.invalid", password: "test-only-password" }),
  ).rejects.toBeDefined();
  // Simulate the admin's explicit approval ONLY in this disposable database.
  sql.prepare("UPDATE auth_users SET status='approved' WHERE id IN (?,?)").run(t.userId, s.userId);
  const login = await signIn(store, {
    email: "journey-student@example.invalid",
    password: "test-only-password",
  });
  expect(login).toBeDefined();
  sql.prepare("UPDATE profiles SET join_code='JRNY00000001' WHERE id=?").run(t.userId);
  await joinTeacher(db, s.userId, "JRNY00000001");
  expect((await getStudentHome(db, s.userId, 0, 0)).teacherLinks).toBe(0);
  await decideEnrollment(db, { id: t.userId, role: "school_teacher" }, s.userId, true);
  const exam = await createAssessment(db, t.userId, "Synthetic journey exam");
  const q = await addQuestion(db, t.userId, exam.id, "written");
  await updateQuestion(db, t.userId, q.id, {
    type: "written",
    prompt: "Explain photosynthesis",
    marks: 10,
    objective: "",
    options: [],
    difficulty: "medium",
    correctAnswer: "",
    acceptedAlternatives: [],
    rubric: "Light and carbon dioxide form glucose",
    explanation: "",
  });
  await setAssessmentStatus(db, t.userId, exam.id, "published");
  expect((await getStudentHome(db, s.userId, 0, 0)).assessments.map((a) => a.id)).toContain(
    exam.id,
  );
  expect((await getTakeData(db, "s", exam.id)).allowed).toBe(false);
  const taken = await getTakeData(db, s.userId, exam.id);
  expect(taken.allowed).toBe(true);
  const sub = await startAttempt(db, s.userId, exam.id, [q.id]);
  expect(
    await saveDraft(db, s.userId, sub.submissionId, [
      { question_id: q.id, response: "Light and CO2 make glucose", time_spent_seconds: 15 },
    ]),
  ).toBe(true);
  expect((await startAttempt(db, s.userId, exam.id, [q.id])).submissionId).toBe(sub.submissionId);
  expect(await saveDraft(db, "s", sub.submissionId, [])).toBe(false);
  expect(await submitAttempt(db, s.userId, sub.submissionId)).toBe(true);
  expect(await saveDraft(db, s.userId, sub.submissionId, [])).toBe(false);
  await expect(releaseSubmission(db, t.userId, sub.submissionId, "")).rejects.toThrow(
    "NOT_APPROVED",
  );
  const answer = sql.prepare("SELECT id FROM answers WHERE submission_id=?").get(sub.submissionId)![
    "id"
  ] as string;
  await expect(reviewAnswer(db, "t", answer, 8, "", "approve")).rejects.toThrow();
  await reviewAnswer(db, t.userId, answer, 8, "Teacher checked", "approve");
  expect(await releaseSubmission(db, t.userId, sub.submissionId, "Reviewed")).toEqual({
    finalScore: 8,
    totalPossible: 10,
  });
  const home = await getStudentHome(db, s.userId, 0, 0);
  expect(home.submissions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: "released", final_score: 8, total_possible: 10 }),
    ]),
  );
  expect(sql.prepare("SELECT COUNT(*) AS n FROM whatsapp_sends").get()!["n"]).toBe(0);
  sql.close();
});
