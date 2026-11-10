// Probe: verify the staging-captured serverFn IDs still resolve on LIVE.
// signIn with bogus creds should return an auth error (not 404/unknown fn);
// getMeD1 without a cookie should return an auth error.
import { call } from "./rpc-live.mjs";

const probes = [
  [
    "signInD1 (bogus creds)",
    () => call("signInD1", { email: "nobody-zzz@example.com", password: "WrongPass123!" }),
  ],
  ["getMeD1 (no cookie)", () => call("getMeD1", {})],
];
for (const [name, fn] of probes) {
  try {
    const r = await fn();
    console.log(name, "=> UNEXPECTED SUCCESS:", JSON.stringify(r.result)?.slice(0, 120));
  } catch (e) {
    console.log(name, "=>", e.message.slice(0, 220));
  }
}
