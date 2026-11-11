# Changelog

## Unreleased

- Security headers (CSP, HSTS, X-Frame-Options) on all Worker responses.
- Health endpoint for uptime monitoring.
- Structured logging for server errors.
- Dependabot weekly dependency updates.
- Tech-debt register (`docs/tech-debt.md`).

## 0.1.0 — 2026-11-11

- Phase 4: Durable Objects serve the exam take path — one `TakeSession`
  per exam, SQLite state, batched flush to D1. Synchronized exam 500/500
  clean with staggered login.
- V3.4: take preparing state ("جاري تجهيز امتحانك…") + 0–10s start jitter.
- Unslop polish: context titles instead of greeting headlines, no Sparkles
  icon, Check icon in the preparing card.
- Live at https://qemmini.adhamelhansye.workers.dev — Arabic-first AI
  assessment for teachers and students: groups with join codes, exams, AI
  grading with the teacher's last word, handwritten grading.
