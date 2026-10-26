/**
 * Plain browser auth storage for Supabase (`auth.storage` option).
 * This is just `localStorage` on the browser and `undefined` on the server
 * (where supabase-js falls back to in-memory behaviour). There is no
 * preview/editor brokering of any kind.
 */

/** Storage accepted by Supabase's `auth.storage` option. */
export interface PreviewAuthStorage {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
}

/** Plain localStorage-backed auth storage, or undefined outside the browser. */
export function browserAuthStorage(): PreviewAuthStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return localStorage;
}

/**
 * @deprecated Kept only so existing imports of the old name don't break.
 * It now returns the plain browser storage above — no preview brokering.
 * Delete this alias once a repo-wide grep confirms nothing imports it.
 */
export const brokeredPreviewStorage = browserAuthStorage;
