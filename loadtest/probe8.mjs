import { toJSON, fromJSON } from "seroval";
const BASE = "https://qemmini-staging.adhamelhansye.workers.dev";
const res = await fetch(
  `${BASE}/_serverFn/35501d0eed8f42788e3c45512b09b5634f2ed483b7a33ede269b887d366714df`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "x-tsr-serverFn": "true",
    },
    body: JSON.stringify(
      toJSON({
        data: { email: "qemmini-staging-admin-20261104@example.com", password: "StagingTest123!" },
      }),
    ),
  },
);
console.log("status", res.status);
for (const [k, v] of res.headers.entries()) console.log("hdr", k, "=", v);
const text = await res.text();
console.log("body len", text.length);
console.log("tail:", text.slice(-120));
// try fromJSON with f/m added
const obj = JSON.parse(text);
obj.f = 127;
obj.m = [];
try {
  console.log("with f/m:", JSON.stringify(fromJSON(obj)));
} catch (e) {
  console.log("with f/m failed:", e.message, "| cause:", e.cause?.message);
}
