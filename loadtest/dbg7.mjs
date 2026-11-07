import { call, signIn } from "./rpc.mjs";
const s = await signIn("func-load-s0000-1762558400000@example.com", "StagingTest123!").catch(async () => {
  // fall back: use fixture student 0
  const { readFileSync } = await import("node:fs");
  const f = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));
  return signIn(f.students[0].email, "StagingTest123!");
});
console.log("signed in:", s.userId);
for (const args of [{ assignmentPage: 0, lessonPage: 0 }, {}]) {
  try {
    const r = await call("getStudentHomeD1", args, s.cookie);
    console.log("args", JSON.stringify(args), "OK:", JSON.stringify(r.result).slice(0, 300));
  } catch (e) { console.log("args", JSON.stringify(args), "FAILED:", e.message.slice(0, 200)); }
}
try {
  const r = await call("getStudentGroupsD1", {}, s.cookie);
  console.log("getStudentGroups OK:", JSON.stringify(r.result).slice(0, 200));
} catch (e) { console.log("getStudentGroups FAILED:", e.message.slice(0, 200)); }
