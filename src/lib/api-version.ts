/**
 * Single source of truth for the TakeSession Durable Object RPC
 * version. Every DO call (see callTakeSession in
 * src/server/d1-take.ts) sends `{ v: API_VERSION, ...body }`.
 *
 * Current value 1 matches the version the DO has served since
 * Phase 4. The DO does not yet reject unknown versions — it ignores
 * `v` — so bumping this constant alone changes nothing on the wire.
 * The bump rule lives in docs/api-versioning.md: when a contract
 * change needs a new version, bump this const AND add the version
 * check on the DO side in the same change.
 */
export const API_VERSION = 1 as const;
