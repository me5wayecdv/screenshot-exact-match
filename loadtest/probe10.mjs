import { toJSON, fromJSON, getPlainObjectPlugins } from "seroval";
import { defaultSerovalDeserializerPlugins } from "@tanstack/router-core/ssr/server";
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
const text = await res.text();
const obj = JSON.parse(text);
for (const [name, plugins] of [
  ["none", undefined],
  ["plain", getPlainObjectPlugins()],
  ["router", defaultSerovalDeserializerPlugins],
]) {
  try {
    console.log(name, "=>", JSON.stringify(fromJSON(obj, plugins ? { plugins } : undefined)));
  } catch (e) {
    console.log(name, "FAILED:", e.cause?.message || e.message);
  }
}
