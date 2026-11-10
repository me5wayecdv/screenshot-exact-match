import { toJSON, fromJSON } from "seroval";
import { BASE } from "./rpc.mjs";
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
const text = await res.text();
console.log("status", res.status, "len", text.length);
const parsed = JSON.parse(text);
console.log("parsed keys:", Object.keys(parsed));
const env = fromJSON({ t: parsed, f: 127, m: [] });
console.log("env:", JSON.stringify(env));
console.log("env.result:", JSON.stringify(env.result));
