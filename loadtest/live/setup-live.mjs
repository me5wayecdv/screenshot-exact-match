// Build the load-test fixture on LIVE only:
// 1 teacher + 1 group + 1 published exam (2 MCQ, maxAttempts 10, linked to the group)
// + N approved students, all joined + membership-approved in the group.
// LIVE has the admin-approval layer: every signup is PENDING until the admin
// approves it via decideAccountD1. Writes live/fixture.json for the runner.
import { call, signIn, pool } from "./rpc-live.mjs";
import { writeFileSync } from "node:fs";

const N = Number(process.argv[2] || 500);
const PASS = "StagingTest123!";
const ADMIN = { email: "qemmini-live-admin-20261104@example.com", password: PASS };

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// --- admin session ---
const admin = await signIn(ADMIN.email, ADMIN.password);
log("admin signed in");

// --- teacher: signup -> admin approve -> sign in ---
const teacherEmail = `func-load-live-teacher-${Date.now()}@example.com`;
const ts = await call("signUpD1", { email: teacherEmail, password: PASS, fullName: "Func Load Live Teacher", role: "school_teacher", teacherPhone: "01012345678", parentPhone: null, subjects: null, school: null });
log("teacher signed up:", ts.result.userId, "status:", ts.result.status);
if (ts.result.status !== "pending") log("WARNING: expected pending status, got", ts.result.status);
await call("decideAccountD1", { userId: ts.result.userId, decision: "approved" }, admin.cookie);
log("teacher approved by admin");
const teacher = await signIn(teacherEmail, PASS);
log("teacher signed in");

// --- group ---
const g = await call("createTeacherGroupD1", { name: "Load Live Group", year: "First secondary", days: ["Sunday"], time: "4:00 PM", notes: "" }, teacher.cookie);
const groupId = g.result.groupId;
const groups = await call("getTeacherGroupsD1", {}, teacher.cookie);
const group = groups.result.find((x) => x.groupId === groupId);
const joinCode = group?.code || group?.joinCode;
log("group:", groupId, "join code:", joinCode);
if (!joinCode) throw new Error("no join code returned");

// --- exam: create + 2 MCQ + maxAttempts 10 + publish + assign to group ---
const ex = await call("createAssessmentD1", { title: "Load Live Test Exam" }, teacher.cookie);
const examId = ex.result.id || ex.result.assessmentId;
log("exam:", examId);
const questionIds = [];
for (const [prompt, correct] of [["What is 2 + 2?", "4"], ["What is 3 + 3?", "6"]]) {
  const q = await call("addQuestionD1", { assessmentId: examId, type: "mcq" }, teacher.cookie);
  const qid = q.result.id || q.result.questionId;
  await call("updateQuestionD1", { questionId: qid, prompt, marks: 1, objective: "", options: ["3", "4", "5", "6"], difficulty: "easy", correctAnswer: correct, acceptedAlternatives: [], rubric: "", explanation: "", type: "mcq" }, teacher.cookie);
  questionIds.push(qid);
}
log("questions:", questionIds.join(", "));
await call("updateAssessmentMetaD1", { assessmentId: examId, title: "Load Live Test Exam", instructions: "", gradeLevel: "First secondary", subjectId: null, newSubjectName: null, dueAt: null, startsAt: null, durationMinutes: null, maxAttempts: 10 }, teacher.cookie);
log("maxAttempts set to 10");

// --- students: signup + admin approve + join group + teacher approves membership ---
const stamp = Date.now();
const emails = Array.from({ length: N }, (_, i) => `func-load-live-s${String(i).padStart(4, "0")}-${stamp}@example.com`);
log(`creating ${N} students...`);
const created = await pool(emails, 20, async (email, i) => {
  const r = await call("signUpD1", { email, password: PASS, fullName: `Func Load Live Student ${i}`, role: "student", parentPhone: "01012345678", teacherPhone: null, subjects: null, school: null });
  return { email, userId: r.result.userId };
});
const bad = created.filter((c) => !c.ok);
if (bad.length) { console.error("signup failures:", bad.slice(0, 3).map((b) => b.error.message)); throw new Error(`${bad.length} student signups failed`); }
log("students signed up (pending)");
const students = created.map((c) => c.value);
const approved = await pool(students, 20, async (s) => {
  await call("decideAccountD1", { userId: s.userId, decision: "approved" }, admin.cookie);
  return s;
});
if (approved.some((a) => !a.ok)) { console.error(approved.filter((a) => !a.ok).slice(0, 3).map((a) => a.error.message)); throw new Error("some admin approvals failed"); }
log("students approved by admin");
const joined = await pool(students, 20, async (s) => {
  const sess = await signIn(s.email, PASS);
  await call("joinGroupD1", { code: joinCode }, sess.cookie);
  return { ...s, cookie: sess.cookie };
});
if (joined.some((j) => !j.ok)) { console.error(joined.filter((j) => !j.ok).slice(0,3).map((j)=>j.error.message)); throw new Error("some group joins failed"); }
log("students joined group (pending)");
const members = await pool(joined.map((j) => j.value), 20, async (s) => {
  await call("decideGroupMembershipD1", { groupId, studentId: s.userId, approve: true }, teacher.cookie);
  return s;
});
if (members.some((m) => !m.ok)) throw new Error("some membership approvals failed");
log("memberships approved");

// --- publish + assign (after students are linked, so publish auto-assigns them) ---
const pub = await call("setAssessmentStatusD1", { assessmentId: examId, status: "published" }, teacher.cookie);
log("published:", JSON.stringify(pub.result));
const asg = await call("assignGroupExamD1", { groupId, assessmentId: examId }, teacher.cookie);
log("group assign:", JSON.stringify(asg.result));

// --- smoke: one student does the full take flow ---
const s0 = members[0].value;
const take = await call("getTakeDataD1", { assessmentId: examId }, s0.cookie);
log("smoke getTakeData allowed:", take.result.allowed, "questions:", JSON.stringify(take.result.questions || take.result).slice(0, 200));
const qs = take.result.questions || [];
const start = await call("startAttemptD1", { assessmentId: examId, questionOrder: qs.map((q) => q.id) }, s0.cookie);
log("smoke startAttempt:", JSON.stringify(start.result));
const draft = await call("saveDraftD1", { submissionId: start.result.submissionId, answers: qs.map((q) => ({ question_id: q.id, response: "4", time_spent_seconds: 5 })) }, s0.cookie);
log("smoke saveDraft:", JSON.stringify(draft.result));
const sub = await call("submitAttemptD1", { submissionId: start.result.submissionId }, s0.cookie);
log("smoke submitAttempt:", JSON.stringify(sub.result));

writeFileSync(new URL("./fixture.json", import.meta.url), JSON.stringify({
  examId, questionIds, groupId, joinCode,
  teacherEmail,
  students: students.map((s) => ({ email: s.email, userId: s.userId })),
  createdAt: new Date().toISOString(),
}, null, 1));
log("fixture written. total setup time:", ((Date.now() - t0) / 1000).toFixed(1), "s");
