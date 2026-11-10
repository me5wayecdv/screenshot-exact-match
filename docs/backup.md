# Backup and restore runbook

## Cloudflare backup (current — D1 + R2)

The live system is Cloudflare-only: D1 database + two R2 buckets. Use
`scripts/backup-d1.mjs` — it exports the D1 database **and** downloads
every R2 object, because grade rows reference papers by `image_path` and
a database-only dump restores broken links:

```sh
# Dry run first (prints the plan, touches nothing):
node scripts/backup-d1.mjs --env staging
# Then, with Cloudflare credentials in the environment:
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
  node scripts/backup-d1.mjs --env staging --confirm
```

Binding rule: the root `wrangler.jsonc` is the authority. It is
staging-bound by default (`qemmini-db`). For a **live** backup, rebind
it to `qemmini-live-db` first (database_name AND database_id, as the
deploy procedure does), run the backup, then restore the config to
staging. Never pass `--config wrangler-live.jsonc`. Staging and live
share both R2 buckets, so an R2 backup for either env contains the
other env's objects too.

Suggested cadence: before every deploy, plus weekly. Keep at least the
last four backups, stored offsite (not in the repo).

## Restore drill (still owed)

This script has **not** been run against a real Cloudflare account yet,
and no restore has been drilled. The first restore drill — to a
throwaway database, then the pilot smoke tests from
`docs/cloudflare-deploy.md` before letting users back in — is part of
the pilot checklist, and this document must be corrected with whatever
that drill teaches.

## Supabase backup (historical — pre-cutover)

The sections below describe the old Supabase backend. The Supabase
project is untouched as a rollback path, but it is NOT the live system
anymore: do not follow these sections for the current Cloudflare
deployment.

What must survive a disaster: the Postgres database (all tables, including
`audit_log` and `handwritten_grades`) and the Supabase Storage bucket
`handwritten-papers` (grade rows reference papers by `image_path`, so a
database restore without the bucket leaves broken links, and vice versa).

## Automated backups (Supabase)

In the Supabase dashboard, open the project → Database → Backups and
confirm automated backups are enabled and note the retention shown for the
current plan (do not assume a number — free and paid plans differ). Take a
manual backup before every production deploy, not just on schedule.

## Manual database backup

Use the connection string from Dashboard → Project Settings → Database.
Never commit it, never paste it into chat, and store dumps encrypted and
offsite (not in the repo):

```sh
pg_dump "<connection-string>" -F c -f qemmini-backup.dump
```

Suggested cadence: before every deploy, plus weekly. Keep at least the
last four dumps.

## Storage backup

`handwritten-papers` is private with folder-based RLS, so a backup must run
with the `service_role` key from a trusted machine (never from the browser
or client code): list all objects, download them preserving their
`{teacher_id}/{uuid}.jpg` paths, and store them alongside the matching
database dump (same date in the filename).

## Restore order (new or repaired project)

1. Create the project, then apply the base migration
   (`drizzle/migrations/0000_migration.sql`) followed by **every** SQL file
   in `supabase/migrations/` in timestamp order. Enumerate the exact files from
   the checked-out release with:
   `find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print | sort`.
   Older abbreviated lists are incomplete. Verify the target migration history
   and schema before restoring or enabling users.
2. Restore the database dump.
3. Restore bucket objects to their original paths (so existing `image_path`
   values resolve again).
4. Rotate every key the old project used (Supabase keys, AI provider keys,
   WhatsApp token) and set the new values in the deployment environment.
5. Run the pilot smoke tests from `docs/cloudflare-deploy.md` before
   letting users back in.

## Honest status

This runbook has **not** been tested with a real restore yet. The first
restore drill — to a throwaway project, before any paid launch — is part
of the pilot checklist, and this document must be corrected with whatever
that drill teaches.
