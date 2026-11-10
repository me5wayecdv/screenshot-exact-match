import { toJSON, fromJSON } from "seroval";
const BASE = "https://qemmini-staging.adhamelhansye.workers.dev";
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
  let parsed = null;
  try {
    parsed = fromJSON(JSON.parse(text));
  } catch (e) {
    parsed = { _parseError: e.message, _raw: text.slice(0, 300) };
  }
  return { status: res.status, setCookie: res.headers.get("set-cookie"), parsed };
}
const SIGNIN = "35501d0eed8f42788e3c45512b09b5634f2ed483b7a33ede269b887d366714df";
const GETME = "53eac8dad0b292b6b08f3a90499fa9b654e689e0c6c3514d78e423bcc54afba4";
const r1 = await call(SIGNIN, {
  email: "qemmini-staging-admin-20261104@example.com",
  password: "StagingTest123!",
});
console.log("signIn:", r1.status, JSON.stringify(r1.parsed));
const cookie = (r1.setCookie || "").split(";")[0];
const r2 = await call(GETME, {}, cookie);
console.log("getMe:", r2.status, JSON.stringify(r2.parsed));
