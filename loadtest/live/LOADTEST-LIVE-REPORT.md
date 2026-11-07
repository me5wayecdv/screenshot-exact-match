# Qemmini — Load Test Report (LIVE)

**Date:** 2026-11-07 · **Target:** https://qemmini.adhamelhansye.workers.dev (Worker `qemmini`, D1 `qemmini-live-db`)
**Run explicitly authorized by the user ("try it on live").** No deploys. Test data created in the live DB is intentional and marked `func-load-live-*` (1 teacher, 1 group, 1 exam, 500 students, their submissions + audit rows). Nothing was deleted afterward — cleanup is a separate user decision.

## Method

Same harness as the staging run (`live/rpc-live.mjs`, `live/run-live.mjs`, `live/setup-live.mjs`), same real student flow via the browser's own HTTP calls (`POST /_serverFn/<id>`, seroval-encoded bodies, `qemmini_session` cookie): sign-in → dashboard (`getStudentHome`) → groups → exam data (`getTakeData`) → start attempt → save draft (2 MCQ answers) → submit. AI endpoints were not tested.

Key difference from staging: live has the admin-approval layer, so setup did signup → admin approve (`decideAccountD1`, admin `qemmini-live-admin-20261104@example.com`) → join group → teacher approves membership, for all 500 students (setup took 144s; publish to 500 linked students took ~45s, `reach: 500, mode: auto_all`). Fixture: 1 teacher, 1 group, 1 published exam (2 MCQ, maxAttempts 10), 500 approved students all joined + membership-approved. Each ladder step launched all N virtual users at once (synchronised burst — the worst case).

## Ladder results

| Concurrent students | Full-flow success | Call error rate | signIn p50 / p95 | startAttempt p50 / p95 | saveDraft p50 / p95 | Step wall time |
|---|---|---|---|---|---|---|
| 50 | 45/50 — 90.0% | 5 / 330 (1.5%) | 3.6s / 3.9s | 1.3s / 1.6s | 1.1s / 1.4s | 10.5s |
| 100 | 30/100 — 30.0% | 70 / 630 (11.1%) | 6.1s / 7.5s | 2.2s / 2.5s | 1.8s / 2.3s | 16.1s |

Steps 150 and 200 were **not run**: the stop rule (>5% errors = breaking point, stop) was already hit at 100.

## Breaking point

**Between 50 and 100 simultaneous students — worse than staging (100–150).** At 50, 90% of students complete the flow; at 100, only 30% do.

## Which layer broke

**1. D1 (the database) — the main break, same error as staging, earlier.**
Exact error, first on the write path:
```
D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window
```
- At 50: no D1 errors at all — the 5 failures were all Worker 1102s (below).
- At 100: `startAttempt` 5/98 failed, `saveDraft` 48/93 failed, `submitAttempt` 15/45 failed — all D1 overloaded. Reads (`getStudentHome`, `getStudentGroups`, `getTakeData`) still held at 0 errors, just slower (takeData p50 2.3s vs 1.2s at 50).

**2. Worker CPU — already biting at 50.**
```
HTTP 503 — Error 1102: Worker exceeded resource limits
```
- At 50: 3 × signIn + 2 × saveDraft failed with 1102. Staging at 50 had zero 1102s; its first 1102 appeared at 150.
- At 100: 2 more signIn 1102s; signIn p50 grew 3.6s → 6.1s (PBKDF2 at 100,000 iterations dominates sign-in CPU).

**3. Not a factor:** the app's own login rate limiting never fired (0 × 429; only *failed* logins count, and ours succeeded). No free-plan daily quota was approached (~960 load calls + ~2,100 setup calls). Nothing was bypassed; the test stopped at the breaking point as instructed.

## Why live breaks earlier than staging

Staging held 100% at 100 concurrent and broke at 150; live breaks at 100 and already shows 1102s at 50. Likely contributors (not individually proven):
- Live D1 (`qemmini-live-db`) carries real accumulated data — sweep accounts/exams/submissions plus the audit-log rows every approval/join/decision writes — so the same queries cost more resources per call inside the 10-second window.
- The live build is newer and heavier: the admin-approval layer adds a status check on session/sign-in paths, and every mutating call writes audit rows.
- The live exam's publish auto-assigned all 500 students (reach 500), so take/start paths touch a much larger assignment set than a fresh staging DB.

## What it means for a real pilot (5–10 teachers, a few hundred students)

- **Total students is still not the problem** — 500 students exist in the live DB and the site works fine for normal, staggered use.
- **The risk is a synchronised exam start, and on live it starts earlier: ~50–100 students pressing "start" in the same seconds.** A whole class starting together will fail for most of them, on `saveDraft` first, then `startAttempt`/`submitAttempt`.
- **Practical mitigations, in order:** stagger exam starts per group (30–60s apart helps a lot); keep a single synchronised start ≤50 students on live as it stands; if synchronised big starts are needed, move D1 to a paid tier and/or cut PBKDF2 cost (fewer iterations, session caching so sign-in doesn't spike CPU on every burst).
- **Side finding (admin):** publishing an exam to 500 linked students took ~45s on live (vs ~27s on staging) — slow but it works.

## Caveats

- Live runs the 2026-11-06 build (admin approval layer, activity feed, split admin sections); staging runs the 2026-11-04 build. The bottlenecks found (D1 throttling, Worker CPU on PBKDF2) are platform-level; the earlier breaking point on live is consistent with a heavier DB + heavier build, but the test does not isolate which factor dominates.
- Harness notes: same as the staging report — seroval over `/_serverFn/<id>`, server errors extracted from raw text. No retries were used; every call counted once.
- Scripts + raw per-call data: `~/workspace/qemmini-cloudflare/loadtest/live/` (`rpc-live.mjs`, `setup-live.mjs`, `run-live.mjs`, `fixture.json`, `results/step-{50,100}.json`).
