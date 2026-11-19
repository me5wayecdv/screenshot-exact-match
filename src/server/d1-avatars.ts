/**
 * Avatar storage (R2). One deterministic object per user at
 * `{userId}/{AVATAR_FOLDER_UUID}/avatar.jpg`, the same enforced key
 * shape as every other bucket (d1-r2.ts): no D1 column is needed and
 * the owner segment always equals the user's own id, so reads are
 * restricted to the session user's own avatar.
 *
 * Writes happen server-side only: at sign-up there is no session yet,
 * so the key is derived from the just-created user id inside
 * signUpD1. Reads go through getMyAvatarD1 (session-checked) and
 * return a data URL the client can render directly.
 */

import { buildR2Key, r2Get, r2Put } from "@/server/d1-r2";
import { getAvatarsBucket } from "@/server/d1";
import { AVATAR_DATA_URL_MAX, AVATAR_DATA_URL_RE } from "@/lib/validation";

export const AVATARS_BUCKET_NAME = "qemmini-avatars";

/** Fixed per-user folder so the key passes the enforced {owner}/{uuid}/{name} shape. */
const AVATAR_FOLDER_UUID = "00000000-0000-0000-0000-000000000000";
const AVATAR_FILE_NAME = "avatar.jpg";

export function avatarKeyFor(userId: string): string {
  return buildR2Key(userId, AVATAR_FOLDER_UUID, AVATAR_FILE_NAME);
}

/** Decode a validated avatar data URL to bytes; null when malformed. */
export function avatarBytesFromDataUrl(dataUrl: string): Uint8Array | null {
  if (dataUrl.length > AVATAR_DATA_URL_MAX || !AVATAR_DATA_URL_RE.test(dataUrl)) return null;
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function putAvatar(userId: string, dataUrl: string): Promise<void> {
  const bytes = avatarBytesFromDataUrl(dataUrl);
  if (!bytes) throw new Error("INVALID_AVATAR");
  const bucket = await getAvatarsBucket();
  await r2Put(bucket, userId, avatarKeyFor(userId), bytes);
}

export async function getAvatarDataUrl(userId: string): Promise<string | null> {
  const bucket = await getAvatarsBucket();
  const buffer = await r2Get(bucket, userId, avatarKeyFor(userId));
  if (!buffer) return null;
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
