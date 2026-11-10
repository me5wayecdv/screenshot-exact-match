import { fromJSON } from "seroval";
const root = {
  t: 10,
  i: 0,
  p: {
    k: ["result", "error", "context"],
    v: [
      {
        t: 10,
        i: 1,
        p: {
          k: ["ok", "userId"],
          v: [
            { t: 2, s: 2 },
            { t: 1, s: "b3b0a4c1-ee8b-48b5-a9ea-9e571828c157" },
          ],
        },
        o: 0,
      },
      { t: 2, s: 1 },
      { t: 11, i: 2, p: { k: [], v: [] }, o: 0 },
    ],
  },
  o: 0,
};
function tryNode(name, node) {
  try {
    console.log(name, "=>", JSON.stringify(fromJSON({ t: node, f: 127, m: [] })));
  } catch (e) {
    console.log(name, "FAILED:", e.cause?.message);
  }
}
tryNode("result-obj", root.p.v[0]);
tryNode("error-undef", root.p.v[1]);
tryNode("context-t11", root.p.v[2]);
tryNode("whole-root", root);
