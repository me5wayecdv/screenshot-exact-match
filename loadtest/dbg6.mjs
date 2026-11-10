import { call, signIn } from "./rpc.mjs";
const email = `probe-student-${Date.now()}@example.com`;
const r = await call("signUpD1", {
  email,
  password: "StagingTest123!",
  fullName: "Probe Student",
  role: "student",
  parentPhone: "01012345678",
  teacherPhone: null,
  subjects: null,
  school: null,
});
console.log("signup result:", JSON.stringify(r.result));
try {
  const s = await signIn(email, "StagingTest123!");
  console.log("immediate sign-in OK:", s.userId);
} catch (e) {
  console.log("immediate sign-in FAILED:", e.message.slice(0, 200));
}
