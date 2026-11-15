/** Run only during an approved deploy, using the existing Cloudflare credentials.
 * Creates one purpose-specific secret only when absent. Never prints secret bytes.
 * Existing keys are never replaced. No provider activation, schema or storage changes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const name = process.argv[2];
if (!["qemmini", "qemmini-staging"].includes(name))
  throw new Error("Explicit Worker name required");
const cli = "node_modules/wrangler/bin/wrangler.js";
const secrets = JSON.parse(
  execFileSync(process.execPath, [cli, "secret", "list", "--name", name, "--format", "json"], {
    encoding: "utf8",
  }),
);
if (!Array.isArray(secrets)) throw new Error("Cannot verify existing secret names");
if (secrets.some((item) => item.name === "GRADE_PREVIEW_SIGNING_KEY")) {
  console.log("Dedicated grade preview signing key already exists; preserving it.");
} else {
  const input = JSON.stringify({
    GRADE_PREVIEW_SIGNING_KEY: randomBytes(32).toString("base64url"),
  });
  const result = spawnSync(process.execPath, [cli, "secret", "bulk", "--name", name], {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      "Signing key setup failed; deployment must stop. Check Cloudflare permissions without logging key data.",
    );
  const updated = JSON.parse(
    execFileSync(process.execPath, [cli, "secret", "list", "--name", name, "--format", "json"], {
      encoding: "utf8",
    }),
  );
  if (!updated.some((item) => item.name === "GRADE_PREVIEW_SIGNING_KEY"))
    throw new Error("New signing key not verified");
  console.log("Dedicated grade preview signing key provisioned and name verified.");
}
