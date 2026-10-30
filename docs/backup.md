# Backup and restore runbook

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
   in `supabase/migrations/` in timestamp order. The current sequence ends
   with `20261030230000_harden_signup_and_exam_rls.sql`; do not use an older
   abbreviated list.
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
