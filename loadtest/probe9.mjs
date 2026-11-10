import { fromJSON } from "seroval";
const tests = [
  ["const true", { t: 2, s: 2 }],
  ["const undef", { t: 2, s: 1 }],
  ["const null", { t: 2, s: 0 }],
  ["string", { t: 1, s: "abc" }],
  ["obj 1 key", { t: 10, i: 0, p: { k: ["ok"], v: [{ t: 2, s: 2 }] }, o: 0 }],
  [
    "obj 2 keys",
    {
      t: 10,
      i: 0,
      p: {
        k: ["ok", "userId"],
        v: [
          { t: 2, s: 2 },
          { t: 1, s: "x" },
        ],
      },
      o: 0,
    },
  ],
  ["empty obj t11", { t: 11, i: 2, p: { k: [], v: [] }, o: 0 }],
];
for (const [name, node] of tests) {
  try {
    console.log(name, "=>", JSON.stringify(fromJSON(node)));
  } catch (e) {
    console.log(name, "FAILED:", e.message, "| cause:", e.cause?.message);
  }
}
