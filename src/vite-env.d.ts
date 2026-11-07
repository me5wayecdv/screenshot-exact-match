/// <reference types="vite/client" />

// Types for the workerd-only `cloudflare:workers` module, statically
// imported by src/server/d1.ts. There is no @cloudflare/workers-types
// dependency in this copy, so the module is declared locally; the
// runtime value comes from workerd itself (production) or from the
// vitest stub (tests). Keep this declaration generic: the typed
// CloudflareEnv shape lives in src/server/d1.ts.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
