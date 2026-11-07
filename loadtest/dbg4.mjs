import { signIn, call } from "./rpc.mjs";
const t = await signIn("func-load-teacher-1762557011513@example.com".replace("1762557011513", String(Date.now()).slice(0,0) || "x"), "StagingTest123!").catch(e => ({ error: e.message }));
console.log("teacher signin:", JSON.stringify(t).slice(0, 200));
