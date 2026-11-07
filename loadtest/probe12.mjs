import { toJSON, fromJSON } from "seroval";
const BASE = "https://qemmini-staging.adhamelhansye.workers.dev";
const res = await fetch(`${BASE}/_serverFn/35501d0eed8f42788e3c45512b09b5634f2ed483b7a33ede269b887d366714df`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json", origin: BASE, "sec-fetch-site": "same-origin", "x-tsr-serverFn": "true" },
  body: JSON.stringify(toJSON({ data: { email: "qemmini-staging-admin-20261104@example.com", password: "StagingTest123!" } })),
});
const text = await res.text();
const obj = JSON.parse(text);
console.log("keys:", Object.keys(obj), "t:", obj.t);
try { console.log("direct:", JSON.stringify(fromJSON(obj))); }
catch (e) { console.log("direct FAILED:", e.cause?.message, "| cause-of-cause:", e.cause?.cause?.message); }
try { console.log("wrapped:", JSON.stringify(fromJSON({ t: obj, f: 127, m: [] }))); }
catch (e) { console.log("wrapped FAILED:", e.cause?.message); }
