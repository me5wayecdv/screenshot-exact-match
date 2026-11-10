// One ladder step: N concurrent virtual students, each running the full
// student flow on STAGING: signIn -> home -> groups -> takeData ->
// startAttempt -> saveDraft -> submitAttempt.
// Usage: node run.mjs <N> [offset]   (offset = first student index, default 0)
import { call, signIn } from "./rpc-live.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const N = Number(process.argv[2]);
const OFFSET = Number(process.argv[3] || 0);
const PASS = "StagingTest123!";
const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));
const students = fixture.students.slice(OFFSET, OFFSET + N);
if (students.length < N) {
  console.error(`only ${students.length} students available from offset ${OFFSET}`);
  process.exit(1);
}

const calls = []; // {vu, endpoint, ms, ok, error}
function record(vu, endpoint, ms, ok, error) {
  calls.push({ vu, endpoint, ms, ok, error: error || null });
}

async function vuFlow(s, i) {
  const t0 = Date.now();
  let sess;
  try {
    sess = await signIn(s.email, PASS);
    record(i, "signIn", sess.ms, true);
  } catch (e) {
    record(i, "signIn", e.ms ?? Date.now() - t0, false, e.message.slice(0, 200));
    return false;
  }
  const cookie = sess.cookie;
  const steps = [
    [
      "getStudentHome",
      () => call("getStudentHomeD1", { assignmentPage: 0, lessonPage: 0 }, cookie),
    ],
    ["getStudentGroups", () => call("getStudentGroupsD1", {}, cookie)],
    ["getTakeData", () => call("getTakeDataD1", { assessmentId: fixture.examId }, cookie)],
  ];
  for (const [name, fn] of steps) {
    try {
      const r = await fn();
      record(i, name, r.ms, true);
    } catch (e) {
      record(i, name, e.ms ?? 0, false, e.message.slice(0, 200));
      return false;
    }
  }
  let submissionId;
  try {
    const r = await call(
      "startAttemptD1",
      { assessmentId: fixture.examId, questionOrder: fixture.questionIds },
      cookie,
    );
    submissionId = r.result.submissionId;
    record(i, "startAttempt", r.ms, true);
  } catch (e) {
    record(i, "startAttempt", e.ms ?? 0, false, e.message.slice(0, 200));
    return false;
  }
  try {
    const r = await call(
      "saveDraftD1",
      {
        submissionId,
        answers: fixture.questionIds.map((q, k) => ({
          question_id: q,
          response: k === 0 ? "4" : "6",
          time_spent_seconds: 5,
        })),
      },
      cookie,
    );
    record(i, "saveDraft", r.ms, true);
  } catch (e) {
    record(i, "saveDraft", e.ms ?? 0, false, e.message.slice(0, 200));
    return false;
  }
  try {
    const r = await call("submitAttemptD1", { submissionId }, cookie);
    record(i, "submitAttempt", r.ms, true);
  } catch (e) {
    record(i, "submitAttempt", e.ms ?? 0, false, e.message.slice(0, 200));
    return false;
  }
  return true;
}

const wall0 = Date.now();
const results = await Promise.allSettled(students.map((s, i) => vuFlow(s, i)));
const wallMs = Date.now() - wall0;
const okVus = results.filter((r) => r.status === "fulfilled" && r.value).length;

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const endpoints = [
  "signIn",
  "getStudentHome",
  "getStudentGroups",
  "getTakeData",
  "startAttempt",
  "saveDraft",
  "submitAttempt",
];
const table = endpoints.map((ep) => {
  const rows = calls.filter((c) => c.endpoint === ep);
  const oks = rows.filter((c) => c.ok);
  const lat = oks.map((c) => c.ms);
  const errs = {};
  for (const r of rows.filter((c) => !c.ok)) errs[r.error] = (errs[r.error] || 0) + 1;
  return {
    endpoint: ep,
    n: rows.length,
    errors: rows.length - oks.length,
    errPct: rows.length ? +(((rows.length - oks.length) / rows.length) * 100).toFixed(1) : 0,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    max: lat.length ? Math.max(...lat) : null,
    topErrors: Object.entries(errs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3),
  };
});
const totalCalls = calls.length,
  totalErrs = calls.filter((c) => !c.ok).length;
const out = {
  step: N,
  offset: OFFSET,
  wallMs,
  vuSuccess: `${okVus}/${N} (${((okVus / N) * 100).toFixed(1)}%)`,
  callErrorRate: `${totalErrs}/${totalCalls} (${((totalErrs / totalCalls) * 100).toFixed(1)}%)`,
  table,
};
console.log(JSON.stringify(out, null, 1));
mkdirSync(new URL("./results", import.meta.url), { recursive: true });
writeFileSync(
  new URL(`./results/step-${N}.json`, import.meta.url),
  JSON.stringify({ ...out, calls }, null, 1),
);
console.log(
  `step ${N}: VU success ${out.vuSuccess}, call error rate ${out.callErrorRate}, wall ${(wallMs / 1000).toFixed(1)}s`,
);
