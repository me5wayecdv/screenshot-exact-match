import { call, signIn } from "./rpc.mjs";
const admin = await signIn("qemmini-staging-admin-20261104@example.com", "StagingTest123!");
console.log("admin:", admin.userId);
const teacherId = "43cbf8be-ee1d-42f0-8c29-da0321a9d8b1";
try {
  const r = await call(
    "decideAccountD1",
    { userId: teacherId, decision: "approved" },
    admin.cookie,
  );
  console.log("decide ok:", JSON.stringify(r.result));
} catch (e) {
  console.log("FAILED status:", e.status, "ms:", e.ms);
  console.log("body:", e.body);
}
