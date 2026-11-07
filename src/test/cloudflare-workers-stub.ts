/**
 * Vitest stub for the workerd-only `cloudflare:workers` module.
 *
 * Wired in vitest.config.ts (resolve.alias) so that src/server/d1.ts
 * can statically import the Worker env without vitest trying to load
 * the real runtime module outside a Worker. The stub env deliberately
 * carries NO bindings: code under test must inject a binding with
 * setD1Binding()/setR2Bindings() or fail loudly with *_NOT_WIRED,
 * exactly as unwired production code does.
 */
export const env: Record<string, unknown> = {};
