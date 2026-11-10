/**
 * Cloudflare Worker entry (Phase 4, 2026-11-10).
 *
 * The default export is the TanStack Start server entry, untouched —
 * fetch handling is exactly what it was. The Phase 3 Queues `queue`
 * export is GONE (the take path moved to Durable Objects; see
 * ports-do/DESIGN.md): the take write path no longer has a queue
 * consumer, and the `queue` handler that caused the 11001 saga
 * (the Queues API reads the handler from the DEFAULT export object)
 * is deleted with it.
 *
 * `TakeSession` is re-exported here so wrangler deploys the DO class:
 * the class must be exported from the Worker's entry module for the
 * `durable_objects` migration (wrangler.jsonc) to apply.
 */
import serverEntry from "@tanstack/react-start/server-entry";

export { TakeSession } from "./server/take-session";

export default {
  fetch: (...args: Parameters<typeof serverEntry.fetch>) => serverEntry.fetch(...args),
};
