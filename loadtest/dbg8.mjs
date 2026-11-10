import { toJSON } from "seroval";
import { BASE, signIn, call } from "./rpc.mjs";
import { readFileSync } from "node:fs";
const f = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));
// fresh student never used in any ladder step (index 450)
const s = await signIn(f.students[450].email, "StagingTest123!");
console.log("signed in:", s.userId);
const res = await fetch(
  `${BASE}/_serverFn/f9f4866d189fa81053953b9b279ac45d9e71666666532c4846bc5bc916b5d8ac`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "x-tsr-serverFn": "true",
      cookie: s.cookie,
    },
    body: JSON.stringify(
      toJSON({ data: { assessmentId: f.examId, questionOrder: f.questionIds } }),
    ),
  },
);
const text = await res.text();
console.log("status:", res.status, "len:", text.length);
console.log("body:", text.slice(0, 800));
