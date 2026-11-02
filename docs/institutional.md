# Institutional and collaboration scope

This document describes the current repository, not the earlier school-workspace
prototype. The school-removal migration (`20261028020000_remove_schools.sql`)
removed school organizations and memberships. There is no `/school` route,
organization/tenant boundary, school-wide administration, or institution-level
billing/SSO in the current application. Do not advertise those capabilities as
implemented.

## Current access model

- Teachers and tutors manage their own assessments and related records.
- Students join a teacher or tutor using the applicable join/lesson flow.
- Database RLS and owner-scoped server functions are the security boundary;
  hiding a UI link is not authorization.
- A tutor's lessons and assessment data remain within that tutor's owner scope.
- School-wide colleague access is not part of the current product model.

Before adding schools or organizations, design an explicit tenant identifier,
validated membership lifecycle, role/permission model, tenant-scoped RLS and
RPCs, data migration, and cross-tenant negative tests. Do not restore the old
school tables or policies as a UI-only feature.

## Grade-review requests

The `/reviews` page supports student requests about released work. Teachers
resolve requests for assessments they own through the protected resolution
function; the client does not receive a general-purpose update path for the
request record. Review the associated RLS policies and RPC before changing this
flow.

## LMS exports

Report pages provide CSV exports through authenticated, RLS-scoped reads. The
question export excludes answer keys; the grades export contains report data
for work the current user is authorized to see. CSV output is BOM-prefixed and
RFC 4180 formatted for spreadsheet compatibility.

## Not built / decisions required

- **Organization accounts and school-wide sharing:** intentionally absent from
  the current schema and routes.
- **SSO and school directory provisioning:** not implemented.
- **Email invitations or bulk import that creates auth users:** not
  implemented; creating auth users requires a trusted server-side Admin API
  path and a service-role key, which must never be exposed to the browser.
- **Billing and subscription entitlements:** not implemented.

The exam timer, autosave, and multiple-attempt experience is implemented; see
`docs/exam-experience.md`. Do not use older phase notes that describe it as
unbuilt.
