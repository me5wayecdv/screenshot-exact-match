# Qemmini — agent notes

- Qemmini is a standalone project: no vendor scaffolding integration
  remains. Do not reintroduce vendor packages, vendor cloud auth,
  preview-auth brokering, or vendor error reporting.
- Do not rewrite pushed git history (no force-push, rebase, or amend of
  commits that are already pushed) on shared branches.
- Shared files are coordinated through the maintainer; do not
  unilaterally edit files owned by another workstream.
