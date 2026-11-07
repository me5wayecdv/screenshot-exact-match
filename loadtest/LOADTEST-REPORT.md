# Qemmini — Load Test Report (STAGING only)

**Date:** 2026-11-07 · **Target:** https://qemmini-staging.adhamelhansye.workers.dev (Worker `qemmini-staging`, D1 `qemmini-db`)
**Live was never touched.** No deploys, no live data. Test accounts: `func-load-*@example.com`, password `StagingTest123!`.

## Method

Real student flow via the same HTTP calls the browser makes (`POST /_serverFn/<id>`, seroval-encoded bodies, `qemmini_session` cookie):
sign-in → dashboard (`getStudentHome`) → groups → exam data (`getTakeData`) → start attempt → save draft (2 MCQ answers) → submit.
Fixture: 1 teacher, 1 group, 1 published exam (2 MCQ, maxAttempts 10), 500 approved students all joined + membership-approved. Each ladder step launched all N virtual users at once (synchronised burst — the worst case: a whole class pressing "start" in the same second). AI endpoints were not tested (no Gemini key on staging, by design).

## Ladder results

| Concurrent students | Full-flow success | Call error rate | signIn p50 / p95 | startAttempt p50 / p95 | saveDraft p50 / p95 | Step wall time |
|---|---|---|---|---|---|---|
| 50 | 50/50 — 100% | 0 / 350 (0%) | 3.3s / 4.1s | 1.1s / 1.7s | 1.2s / 1.5s | 9.5s |
| 100 | 100/100 — 100% | 0 / 700 (0%) | 5.9s / 7.1s | 1.9s / 2.4s | 1.7s / 2.1s | 14.8s |
| 150 | 2/150 — 1.3% | 148 / 869 (17.0%) | 10.2s / 11.1s | 2.4s / 2.6s (32 errors) | 2.3s / 2.4s (111/117 errors) | 18.6s |
| 200 | 0/200 — 0% | 200 / 959 (20.9%) | 12.1s / 14.2s | — (159/159 errors) | — (never reached) | 19.8s |

The 500 step was **not run**: the stop rule (>5% errors = breaking point, stop) was already hit at 150–200.

## Breaking point

**Between 100 and 150 simultaneous students.** At 100 everything passes; at 150 the flow collapses (1.3% complete it); at 200 nobody completes it.

## Which layer broke

**1. D1 (the database) — the main break.**
Exact error, returned by the server on the write path first, then on reads too:
```
D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window
```
- At 150: `startAttempt` 32/149 failed, `saveDraft` 111/117 failed, `submitAttempt` 4/6 failed.
- At 200: `getTakeData` (a read) also failed 41/200, `startAttempt` 159/159 failed.
D1 throttles when too much work lands inside a 10-second window; concurrent writes (attempt + answers + submit) are the first to die. This is a Cloudflare free-tier D1 limit, not an app bug.

**2. Worker CPU — the second constraint (sign-in).**
Sign-in latency grows with concurrency (p50: 3.3s → 5.9s → 10.2s → 12.1s) because password verification is PBKDF2 at 100,000 iterations. At 150, one sign-in failed outright:
```
HTTP 503 — Error 1102: Worker exceeded resource limits
```
At 100 concurrent sign-ins the p95 is already 7.1s — slow, but it works.

**3. Not a factor:** the app's own login rate limiting never fired (0 × 429; only *failed* logins count, and ours succeeded). No free-plan daily quota was approached (~2,900 load calls + ~2,500 setup calls). Nothing was bypassed; the test stopped at the breaking point as instructed.

## What it means for a real pilot (5–10 teachers, a few hundred students)

- **A few hundred students in total is fine.** The test only breaks when 100–150 students hit the exam flow in the *same few seconds*.
- **The risk is a synchronised exam start** — a whole class pressing "start" at the same moment. In a real pilot students naturally stagger by seconds/minutes, which spreads the D1 load and should keep it under the limit. But a deliberately synchronised start (e.g. a teacher telling 150 students "start now") will fail for most of them, on `startAttempt`/`saveDraft` first.
- **Practical mitigations, in order:** stagger exam starts per group (even 30–60s apart helps a lot); keep the pilot at ≤100 simultaneous starters; if synchronised big starts are needed, move D1 to a paid tier or a higher-throughput database, and consider lowering PBKDF2 cost or caching sessions so sign-in doesn't spike CPU.
- **Side finding (admin):** publishing an exam to 500 linked students took ~27s (publish auto-assigns all of them) — slow but it works.

## Caveats

- Staging runs the 2026-11-04 build (it predates the admin-approval layer — signups there are auto-approved, and `decideAccountD1` doesn't exist on staging). The bottlenecks found (D1 throttling, Worker CPU on PBKDF2) are platform-level and apply to live the same way; live runs the same Worker + D1 architecture.
- Harness notes: the browser client speaks seroval over `/_serverFn/<id>`; response bodies are bare seroval nodes and decode as `fromJSON({t: body, f: 127, m: []})`. Server errors come back as HTTP 200 envelopes with a serialized Error — a plain `fromJSON` without plugins can't decode those, so the harness extracts the message from the raw text. One early 50-VU run misread those as decode errors; the re-runs above report the real server errors.
- Scripts + raw per-call data: `~/workspace/qemmini-cloudflare/loadtest/` (`rpc.mjs`, `setup.mjs`, `run.mjs`, `fixture.json`, `results/step-{50,100,150,200}.json`).
