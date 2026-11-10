#!/usr/bin/env node
/**
 * D1 + R2 backup (ported from the rebuild's scripts/backup-d1.mjs).
 *
 * Safe by default: without --confirm this only prints a plan and touches nothing.
 *
 * The rule this script exists to enforce: a database backup WITHOUT the matching
 * R2 objects is not a backup. `handwritten_grades.image_path` and the source
 * rows point into the buckets, so restoring the SQL alone leaves broken links.
 * So if the R2 credentials are missing the script aborts BEFORE exporting
 * anything, rather than writing a dump that looks complete and is not.
 *
 * Old-repo wrangler layout (DIFFERS from the rebuild — read this before
 * running a live backup):
 * - There is ONE live config: the root `wrangler.jsonc`. It is staging-bound
 *   by default (database qemmini-db). `wrangler-live.jsonc` exists in the
 *   repo but `--config wrangler-live.jsonc` is broken for deploys — this
 *   script NEVER passes --config anywhere; it runs wrangler from the repo
 *   root so the root config is read naturally.
 * - For --env live, the root config must FIRST be rebound to the live
 *   database (database_name qemmini-live-db AND database_id
 *   3d9fae1b-acb7-426c-a7ec-307217fab151), exactly as the deploy procedure
 *   does — edit root config, run the backup, restore root config to
 *   staging. If the config still points at qemmini-db, --env live refuses
 *   with instructions instead of silently backing up staging.
 * - Staging and live SHARE both R2 buckets (qemmini-handwritten-papers,
 *   qemmini-generation-sources). There is no per-env bucket split in the
 *   old setup, so an R2 backup taken for either env contains the other
 *   env's objects too. The plan prints this warning every run.
 *
 * Nothing here has been run against a real Cloudflare account. The restore
 * drill (restore to a throwaway database, then run the pilot smoke tests)
 * is still owed — see docs/backup.md — and this script must not be treated
 * as tested until that drill passes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The single root config is the authority for which database is bound. */
const ROOT_CONFIG = "wrangler.jsonc";

/** What --env expects the root config to be bound to right now. */
const EXPECTED_DATABASE = {
  staging: "qemmini-db",
  live: "qemmini-live-db",
};
const LIVE_DATABASE_ID = "3d9fae1b-acb7-426c-a7ec-307217fab151";

/** Strips // comments and trailing commas so JSON.parse can read a .jsonc.
 * Deliberately narrow: it does not try to be a general JSONC parser, and it
 * refuses to guess if the result still will not parse. */
export function parseJsonc(text) {
  const withoutComments = text
    .split("\n")
    .map((line) => {
      // Only strip a // that is not inside a quoted string.
      let inString = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
        if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
}

export function buildPlan({ env, outDir, stamp, configDir = appRoot }) {
  if (!EXPECTED_DATABASE[env]) {
    throw new Error(`Unknown env "${env}". Use --env staging or --env live.`);
  }
  const configPath = join(configDir, ROOT_CONFIG);
  if (!existsSync(configPath)) throw new Error(`Missing config: ${ROOT_CONFIG}`);
  const config = parseJsonc(readFileSync(configPath, "utf8"));
  const db = config.d1_databases?.find((entry) => entry.binding === "DB");
  if (!db) throw new Error(`${ROOT_CONFIG} has no DB binding.`);
  if (!db.database_id || db.database_id.endsWith("_REQUIRED")) {
    throw new Error(
      `${ROOT_CONFIG} still has a placeholder database_id. Create the database and record its id first.`,
    );
  }
  // The root config is rebound between staging and live by hand (see the
  // header). Refuse to back up the wrong database instead of guessing.
  if (db.database_name !== EXPECTED_DATABASE[env]) {
    const hint =
      env === "live"
        ? `Rebind first: edit ${ROOT_CONFIG} database_name to "qemmini-live-db" AND database_id to "${LIVE_DATABASE_ID}", run this backup, then restore the config to staging (qemmini-db). Never use --config wrangler-live.jsonc.`
        : `Rebind first: edit ${ROOT_CONFIG} database_name back to "qemmini-db" (and its staging database_id), then run this backup.`;
    throw new Error(
      `${ROOT_CONFIG} is currently bound to database "${db.database_name}", not "${EXPECTED_DATABASE[env]}". ${hint}`,
    );
  }
  const buckets = (config.r2_buckets ?? []).map((entry) => ({
    binding: entry.binding,
    bucketName: entry.bucket_name,
  }));
  if (buckets.length === 0) throw new Error(`${ROOT_CONFIG} declares no R2 buckets.`);
  const dir = join(outDir, `${env}-${stamp}`);
  return {
    env,
    config: ROOT_CONFIG,
    worker: config.name,
    database: { name: db.database_name, id: db.database_id },
    buckets,
    // Staging and live share both buckets in the old setup: an R2 backup
    // for either env contains the other env's objects too.
    sharedBucketsWarning:
      "Staging and live share these buckets; this backup's R2 objects are not env-scoped.",
    outDir: dir,
    files: {
      sql: join(dir, "d1-export.sql"),
      r2Manifest: join(dir, "r2-manifest-<bucket>.json"),
      r2Objects: join(dir, "r2", "<bucket>", "<key>"),
      readme: join(dir, "BACKUP-INFO.json"),
    },
    steps: [
      `wrangler d1 export ${db.database_name} --remote --output ${join(dir, "d1-export.sql")} --skip-confirmation`,
      ...buckets.map(
        (bucket) => `list + download every object in ${bucket.bucketName} preserving its key`,
      ),
      "verify: object count in manifest == objects downloaded; SQL dump is non-empty",
    ],
  };
}

function argOf(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(
      [
        "Usage: node scripts/backup-d1.mjs --env <staging|live> [--out DIR] [--confirm]",
        "",
        "Without --confirm this prints the plan as JSON and touches nothing.",
        "With --confirm it exports D1 and downloads every R2 object.",
        "",
        "Binding rule: the root wrangler.jsonc is the authority. For --env live",
        "it must already be rebound to qemmini-live-db (see the script header).",
        "Never pass --config wrangler-live.jsonc.",
        "",
        "Required for --confirm:",
        "  CLOUDFLARE_ACCOUNT_ID   account that owns the buckets",
        "  CLOUDFLARE_API_TOKEN    token with D1 read + R2 read",
        "",
        "A database dump without the buckets is NOT a backup: the script aborts",
        "before exporting if the R2 credentials are absent.",
      ].join("\n"),
    );
    return 0;
  }

  const env = argOf(argv, "--env");
  const outDir = argOf(argv, "--out") ?? join(appRoot, ".backups");
  const confirm = argv.includes("--confirm");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  let plan;
  try {
    plan = buildPlan({ env, outDir, stamp });
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }

  if (!confirm) {
    console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    console.error("\nDry run only. Nothing was read or written. Pass --confirm to execute.");
    return 0;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error(
      "ERROR: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.\n" +
        "Refusing to write a database-only backup: grade rows reference bucket\n" +
        "objects, so a dump without them restores broken links. Nothing was exported.",
    );
    return 3;
  }

  mkdirSync(plan.outDir, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        join(appRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
        "d1",
        "export",
        plan.database.name,
        "--remote",
        "--output",
        plan.files.sql,
        "--skip-confirmation",
      ],
      { cwd: appRoot, stdio: "inherit", env: { ...process.env, CI: "1", NO_COLOR: "1" } },
    );
  } catch {
    console.error("ERROR: D1 export failed. The backup is incomplete; do not rely on it.");
    return 4;
  }

  // R2 listing uses the Cloudflare API because the Wrangler CLI has no
  // "list objects" command. Each key is then downloaded verbatim so a restore
  // can put the object back at the path the database already references.
  const objectsDir = join(plan.outDir, "r2");
  const counts = {};
  for (const bucket of plan.buckets) {
    const keys = [];
    let cursor;
    do {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket.bucketName}/objects`,
      );
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` } });
      const body = await response.json();
      if (!response.ok || !body.success) {
        console.error(`ERROR: listing ${bucket.bucketName} failed. Backup INCOMPLETE.`);
        return 5;
      }
      for (const object of body.result ?? []) keys.push({ key: object.key, size: object.size });
      cursor = body.result_info?.cursor;
    } while (cursor);

    let downloaded = 0;
    for (const object of keys) {
      const target = join(objectsDir, bucket.bucketName, object.key);
      mkdirSync(dirname(target), { recursive: true });
      try {
        execFileSync(
          process.execPath,
          [
            join(appRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
            "r2",
            "object",
            "get",
            `${bucket.bucketName}/${object.key}`,
            "--remote",
            "--file",
            target,
          ],
          { cwd: appRoot, stdio: "pipe", env: { ...process.env, CI: "1", NO_COLOR: "1" } },
        );
      } catch {
        console.error(
          `ERROR: could not download ${bucket.bucketName}/${object.key}. Backup INCOMPLETE.`,
        );
        return 6;
      }
      downloaded += 1;
    }
    // A silent shortfall is the failure mode that makes a restore look fine
    // until a grade row points at a missing paper. Compare counts explicitly.
    if (downloaded !== keys.length) {
      console.error(
        `ERROR: ${bucket.bucketName}: ${downloaded}/${keys.length} objects. INCOMPLETE.`,
      );
      return 6;
    }
    counts[bucket.bucketName] = { listed: keys.length, downloaded };
    writeFileSync(
      join(plan.outDir, `r2-manifest-${bucket.bucketName}.json`),
      JSON.stringify(keys, null, 2),
    );
  }
  writeFileSync(
    plan.files.readme,
    JSON.stringify(
      {
        env: plan.env,
        takenAt: new Date().toISOString(),
        database: plan.database.name,
        buckets: counts,
        sqlBytes: readFileSync(plan.files.sql).length,
        complete: true,
        note:
          "SQL dump plus every listed R2 object, downloaded to r2/<bucket>/<key>. " +
          "Staging and live share these buckets, so the R2 half is not env-scoped. " +
          "Verify the counts above against the manifests before relying on this backup, " +
          "then run the restore drill in docs/backup.md.",
      },
      null,
      2,
    ),
  );
  console.log(`Backup written to ${plan.outDir}`);
  console.log("NEXT: run the restore drill in docs/backup.md against a throwaway database.");
  return 0;
}

// Only run when invoked directly, so tests can import buildPlan/parseJsonc.
if (process.argv[1] && process.argv[1].endsWith("backup-d1.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`ERROR: ${error.message}`);
      process.exit(1);
    },
  );
}
