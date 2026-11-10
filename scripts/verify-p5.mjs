#!/usr/bin/env node
// Verify P5 (scripts/backup-d1.mjs) — plan-building only, no Cloudflare.
// Run: node verify-p5.mjs (from the work-copy root).
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, parseJsonc } from "./backup-d1.mjs";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

// 1) Staging plan builds from the real root config (staging-bound).
const staging = buildPlan({ env: "staging", outDir: "/tmp/qemmini-backup-test", stamp: "t0" });
check("staging plan env", staging.env === "staging");
check("staging plan database", staging.database.name === "qemmini-db");
check("staging plan database id", staging.database.id === "382015c0-8484-4143-b2e3-7391b0fffb7d");
check("staging plan buckets", staging.buckets.length === 2);
check(
  "staging plan bucket names",
  staging.buckets.map((b) => b.bucketName).join(",") ===
    "qemmini-handwritten-papers,qemmini-generation-sources",
);
check("staging plan warns about shared buckets", staging.sharedBucketsWarning.includes("share"));
check(
  "staging plan steps mention d1 export",
  staging.steps[0].includes("wrangler d1 export qemmini-db"),
);
check("staging plan has no --config flag", !staging.steps.join(" ").includes("--config"));

// 2) Live plan refuses while the root config is staging-bound.
let liveError = "";
try {
  buildPlan({ env: "live", outDir: "/tmp/qemmini-backup-test", stamp: "t0" });
} catch (e) {
  liveError = e.message;
}
check("live plan refuses staging-bound config", liveError.includes("qemmini-db"));
check("live refusal names the rebind", liveError.includes("qemmini-live-db"));
check(
  "live refusal forbids --config wrangler-live.jsonc",
  liveError.includes("--config wrangler-live.jsonc"),
);

// 3) Live plan builds when the config is rebound (temp dir, real config copied + edited).
const dir = mkdtempSync(join(tmpdir(), "qemmini-backup-live-"));
const liveConfig = readFileSync("wrangler.jsonc", "utf8")
  .replace('"database_name": "qemmini-db"', '"database_name": "qemmini-live-db"')
  .replace(
    '"database_id": "382015c0-8484-4143-b2e3-7391b0fffb7d"',
    '"database_id": "3d9fae1b-acb7-426c-a7ec-307217fab151"',
  );
writeFileSync(join(dir, "wrangler.jsonc"), liveConfig);
const live = buildPlan({
  env: "live",
  outDir: "/tmp/qemmini-backup-test",
  stamp: "t0",
  configDir: dir,
});
check("live plan builds when rebound", live.database.name === "qemmini-live-db");
check("live plan database id", live.database.id === "3d9fae1b-acb7-426c-a7ec-307217fab151");
check("live plan still has no --config flag", !live.steps.join(" ").includes("--config"));

// 4) Unknown env + missing config are loud errors.
let unknownError = "";
try {
  buildPlan({ env: "prod", outDir: "/tmp/x", stamp: "t0" });
} catch (e) {
  unknownError = e.message;
}
check("unknown env rejected", unknownError.includes('Unknown env "prod"'));

// 5) parseJsonc handles the real root config (comments + trailing commas).
const parsed = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
check("parseJsonc reads wrangler.jsonc", parsed.name === "qemmini");
check("parseJsonc finds DB binding", parsed.d1_databases?.[0]?.binding === "DB");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
