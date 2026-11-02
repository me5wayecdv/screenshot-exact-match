# Production launch gates

This checklist separates repository evidence from hosted-system verification.
A checked-in migration or test is not proof that Supabase or Cloudflare is
configured correctly. Do not mark a gate complete without retaining the
staging/deployment evidence.

## Required before real student use

- [ ] **Migration rehearsal:** apply the Drizzle baseline
  (`drizzle/migrations/0000_migration.sql`) and every
  `supabase/migrations/*.sql` file from the checked-out release, in timestamp
  order, to a disposable database. Verify the final schema matches the
  application. Enumerate the exact release list with
  `find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print | sort`.
- [ ] **Staging authorization tests:** use separate student, teacher, tutor,
  and administrator accounts to test RLS/RPC boundaries, including unreleased
  grades, submitted/expired attempts, direct writes, answer keys, and join
  codes. Follow `docs/security-review.md` and
  `docs/backend-security-scale-rollout.md`.
- [ ] **End-to-end pilot:** complete every smoke test in
  `docs/cloudflare-deploy.md`, including Arabic and English OCR, grading,
  result release, generation, and AI-unconfigured failures.
- [ ] **Restore drill:** restore both Postgres and private Storage objects to a
  throwaway project and verify handwritten-paper links. Follow `docs/backup.md`.
- [ ] **Privacy/data governance:** confirm the operational privacy contact,
  applicable jurisdictional review, consent for minors, AI-provider disclosures,
  retention periods, and a tested access/correction/deletion process. The
  privacy text currently states broad principles; it does not itself implement
  account deletion or a retention scheduler.
- [ ] **Operations:** configure and exercise alerts for Worker errors, database
  failures, AI provider failures, quota exhaustion, and unexpected cost. Set
  usage budgets based on actual provider terms and pilot traffic.
- [ ] **Human support:** document how teachers report incorrect grades/OCR,
  request data changes/deletion, and get urgent account help.

## Automated repository checks

Pull requests run typecheck, unit/component tests, lint, and a production build
through `.github/workflows/ci.yml`. These checks do not connect to Supabase,
apply migrations, measure model quality, or replace the staging/restore gates
above.

## Product decisions before a broader school launch

Decide whether Qayyimni remains for individual teachers/tutors or becomes a
multi-organization SaaS. The current application has no organization-level
tenancy, institution administration, SSO, or billing; see
`docs/institutional.md`. Decide separately whether tutor history and handwritten
batch queues should persist across devices/sessions, including the associated
student-data retention and shared-device privacy policy.
