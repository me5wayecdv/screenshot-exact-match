import { toJSON } from "seroval";
import { BASE } from "./rpc.mjs";
import { signIn } from "./rpc.mjs";
const admin = await signIn("qemmini-staging-admin-20261104@example.com", "StagingTest123!");
const res = await fetch(
  `${BASE}/_serverFn/b8430f235d9532f29ac4dc0e0cded3c4aa0cced82b1d998333ace21c34c43866`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "x-tsr-serverFn": "true",
      cookie: admin.cookie,
    },
    body: JSON.stringify(
      toJSON({ data: { userId: "43cbf8be-ee1d-42f0-8c29-da0321a9d8b1", decision: "approved" } }),
    ),
  },
);
const text = await res.text();
console.log("status", res.status, "len", text.length);
// strip tags to find the message
const stripped = text
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();
console.log(stripped.slice(0, 1500));
