import { deserialize, fromJSON, getPlainObjectPlugins } from "seroval";
const body = '{"t":10,"i":0,"p":{"k":["result","error","context"],"v":[{"t":10,"i":1,"p":{"k":["ok","userId"],"v":[{"t":2,"s":2},{"t":1,"s":"b3b0a4c1-ee8b-48b5-a9ea-9e571828c157"}]},"o":0},{"t":2,"s":1},{"t":11,"i":2,"p":{"k":[],"v":[]},"o":0}]},"o":0}';
try { console.log("deserialize:", JSON.stringify(deserialize(body))); }
catch (e) { console.log("deserialize failed:", e.message); }
try { console.log("fromJSON+plainPlugins:", JSON.stringify(fromJSON(JSON.parse(body), { plugins: getPlainObjectPlugins() }))); }
catch (e) { console.log("fromJSON+plainPlugins failed:", e.message); }
