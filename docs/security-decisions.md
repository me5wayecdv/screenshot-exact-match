# Qayymni security and product decisions

This register separates code defects from decisions that affect product behavior,
privacy commitments, or rollout risk. Recommendations are proposals, not silent
changes to production behavior.

| Area | Current behavior / open question | Recommended decision | Why it is not changed in this patch |
| --- | --- | --- | --- |
| Content Security Policy | CSP still permits `unsafe-inline`. | Keep temporarily while inventorying inline scripts/styles; then move to nonce/hash-based policy and test every route before removing it. | Removing it blindly can break hydration, styles, or integrations. |
| Password reset tokens | Reset token is delivered in a URL query parameter, one-time and time-limited. | Move the token to a URL fragment or one-time POST exchange; ensure referrer policy and access logs do not retain it. | Requires coordinated changes to email links, reset page parsing, and token exchange. |
| Password strength | Minimum length is currently eight characters. | Raise to at least 12 characters without arbitrary composition rules; consider breached-password screening. | A policy change affects signup and reset UX and needs support messaging. |
| Password visibility | Signup currently exposes the typed password by default. | Default to masked input with an explicit show/hide control. | This is a user-facing UX/security decision; the original review did not establish explicit approval. |
| Take-session cache | Some access/config decisions can remain cached for up to 60 seconds. | Preserve the current bound until release/revocation invalidation is tested; then prefer event-driven invalidation over a smaller polling TTL. | The cache protects D1 under synchronized exam load; shortening it can reintroduce overload. |
| Publish audience | `auto_all` can include newly linked/approved students when publishing or topping up. | Show the exact audience count and require explicit confirmation whenever publication expands the audience. | Changing the rule without checking all publish flows can strand students or silently widen access. |
| Retention and deletion | `docs/retention-policy.md` still contains 21 `[DECISION NEEDED]` markers; full account deletion is not yet verified end-to-end. | Approve a retention schedule per data category, deletion SLA, backup expiry, and documented exception process before public launch. | These are legal/product commitments; inventing durations in code would be unsafe. |

## Operational gates before production

1. Approve the retention schedule with the product owner and applicable privacy/legal requirements.
2. Verify reset-token transport in staging before switching email links.
3. Verify CSP changes with a browser route sweep and no console CSP violations.
4. Test publish-audience confirmation with existing, newly approved, and removed students.
5. Verify account deletion across D1, R2, audit/retention exceptions, and backups.

No production database, secret, Worker binding, or deployment is changed by this register.
