import { toJSON } from "seroval";
const BASE = "https://qemmini-staging.adhamelhansye.workers.dev";
const FN = {
  signInD1: "35501d0eed8f42788e3c45512b09b5634f2ed483b7a33ede269b887d366714df",
  getMeD1: "53eac8dad0b292b6b08f3a90499fa9b654e689e0c6c3514d78e423bcc54afba4",
};
async function call(id, data, cookie) {
  const res = await fetch(`${BASE}/_serverFn/${id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "x-tsr-serverFn": "true",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(toJSON({ data })),
  });
  const text = await res.text();
  return { status: res.status, setCookie: res.headers.get("set-cookie"), body: text.slice(0, 400) };
}
const r1 = await call(FN.signInD1, { email: "qemmini-staging-admin-20261104@example.com", password: "StagingTest123!" });
console.log("signIn:", r1.status, "| set-cookie:", (r1.setCookie||"").slice(0,100), "| body:", r1.body);
const cookie = (r1.setCookie||"").split(";")[0];
if (cookie) {
  const r2 = await call(FN.getMeD1, {}, cookie);
  console.log("getMe:", r2.status, "| body:", r2.body);
}
