// Minimal TanStack Start serverFn RPC client for the Qemmini staging worker.
// Encodes request bodies with seroval (toJSON) and decodes responses the same
// way the browser client does. Sends Origin + Sec-Fetch-Site so the
// server's CSRF middleware accepts the call. Session = qemmini_session cookie.
import { toJSON, fromJSON } from "seroval";

export const BASE = "https://qemmini.adhamelhansye.workers.dev";

const FN = {
  signInD1: "35501d0eed8f42788e3c45512b09b5634f2ed483b7a33ede269b887d366714df",
  signUpD1: "f09fda22723491f32d1216d3159b73ee456dff0ee90232ca7fdc717ca6e9f989",
  getMeD1: "53eac8dad0b292b6b08f3a90499fa9b654e689e0c6c3514d78e423bcc54afba4",
  decideAccountD1: "b8430f235d9532f29ac4dc0e0cded3c4aa0cced82b1d998333ace21c34c43866",
  createTeacherGroupD1: "d3d3fd622048d94c52b4bab8703011eefbbaeeeda9118514fd7009ab70f631d8",
  getTeacherGroupsD1: "6f54bcb03cac83d198dc1ef13e911518e8fdfcae693d67342e866ce8eacbd36c",
  createAssessmentD1: "3e435d889858690a8ce576d41dc511535ebcf009c28c0e9cd0ccb7f790ec77a4",
  addQuestionD1: "95de60f2a8d0209902b01ea03dec99f87cf96f8cf9f422d0e0ddc51dc9c123bf",
  updateQuestionD1: "12ff10590812d3d5a20dfefc57a95636cf89d04c0ed5e1cce6d137cc2b2cf4e9",
  updateAssessmentMetaD1: "55b8d76f30e47ac5c190350a69ac3bc06a7faa56c88caaa5c7031b873b996d2a",
  setAssessmentStatusD1: "8faa222c55f2676036bee1a5b3470a2b7007e1f24bdeadb0ad8a6c5b27cbd430",
  assignGroupExamD1: "b2a875bab65704c8a7f219e26a0ca09a2ded811a7c18427f285ee298b9b75835",
  joinGroupD1: "0f858478eea188f10720b8d865ecb273a45b2fae5c823e2de6d699a4e59b1b54",
  decideGroupMembershipD1: "65a8620b5843b50217bffa3e178d06cc057b5ecb1c60d940ceec8e15f29cfb78",
  getStudentHomeD1: "84f18ec717aacdfb4ca6dcde83489d2d90ef822fc962ddced60cf7e44a5c864e",
  getStudentGroupsD1: "d3df49881843a5c2f3758e17af55a87745baf3abf40c427a87ae680fcf5ee353",
  getTakeDataD1: "b0b558f03b886c1ee9759b7f1c4877690ede684e4f078b80f7e282540ebff26a",
  startAttemptD1: "f9f4866d189fa81053953b9b279ac45d9e71666666532c4846bc5bc916b5d8ac",
  saveDraftD1: "3b5396a2744ae95027f421683f3f23eb13a97b0acb6ef15193c54c11fc973799",
  submitAttemptD1: "f30331e4586c3fc115ee4edf7dddc6f3632465417f121a13ac4fa761d47107cd",
};

export function decode(text) {
  const parsed = JSON.parse(text);
  return fromJSON({ t: parsed, f: 127, m: [] });
}

export async function call(name, data, cookie) {
  const id = FN[name];
  if (!id) throw new Error(`unknown fn ${name}`);
  const t0 = Date.now();
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
  const ms = Date.now() - t0;
  const setCookie = res.headers.get("set-cookie");
  if (res.status !== 200) {
    // Error bodies are seroval-encoded; pull the human message out of the raw text.
    const m = text.match(/"message":\{"t":1,"s":"((?:[^"\\]|\\.)*)"\}/);
    const detail = m ? JSON.parse(`"${m[1]}"`) : text.slice(0, 300);
    const err = new Error(`HTTP ${res.status} ${name}: ${detail}`);
    err.status = res.status;
    err.ms = ms;
    err.body = text.slice(0, 300);
    throw err;
  }
  let env;
  try {
    env = decode(text);
  } catch {
    // The server returned a 200 envelope whose `error` is a serialized
    // Error object (a seroval plugin node). Plain fromJSON cannot decode
    // it — pull the message straight out of the raw text instead.
    const m = text.match(/"message":\{"t":1,"s":"((?:[^"\\]|\\.)*)"\}/);
    const detail = m ? JSON.parse(`"${m[1]}"`) : `undecodable response: ${text.slice(0, 200)}`;
    const err = new Error(`${name}: ${detail}`);
    err.ms = ms;
    err.serverError = detail;
    throw err;
  }
  if (env.error != null) {
    const msg = env.error?.message || JSON.stringify(env.error)?.slice(0, 300) || "server error";
    const err = new Error(`${name}: ${msg}`);
    err.ms = ms;
    err.serverError = msg;
    throw err;
  }
  return { result: env.result, ms, setCookie };
}

export async function signIn(email, password) {
  const { result, ms, setCookie } = await call("signInD1", { email, password });
  const cookie = (setCookie || "").split(";")[0];
  if (!cookie) throw new Error(`signIn ${email}: no session cookie`);
  return { userId: result.userId, cookie, ms };
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (e) {
        out[idx] = { ok: false, error: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
