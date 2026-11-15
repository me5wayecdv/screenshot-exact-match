import type { AiGradeSuggestion } from "./ai-client";
export type GradePreview = {
  v: 1;
  purpose: "qemmini.handwritten.preview";
  id: string;
  fingerprint: string;
  expiresAt: number;
  suggestion: AiGradeSuggestion;
  model: string | null;
};
const encoder = new TextEncoder();
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("INVALID_PREVIEW");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
}
async function key(): Promise<CryptoKey> {
  const secret = process.env["GRADE_PREVIEW_SIGNING_KEY"];
  if (!secret || secret.length < 43) throw new Error("PREVIEW_SIGNING_NOT_CONFIGURED");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function assertGradePreviewSigning(): Promise<void> {
  await key();
}
export async function signGradePreview(payload: GradePreview): Promise<string> {
  const body = encode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await key(), encoder.encode(body));
  return `${body}.${encode(new Uint8Array(signature))}`;
}
export async function verifyGradePreview(token: string): Promise<GradePreview> {
  if (token.length > 100000) throw new Error("INVALID_PREVIEW");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("INVALID_PREVIEW");
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await key(),
      decode(parts[1]) as BufferSource,
      encoder.encode(parts[0]),
    ))
  )
    throw new Error("INVALID_PREVIEW");
  const payload = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as GradePreview;
  if (
    payload.v !== 1 ||
    payload.purpose !== "qemmini.handwritten.preview" ||
    !/^[0-9a-f-]{36}$/i.test(payload.id) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt <= Date.now() ||
    payload.expiresAt > Date.now() + 31 * 60000
  )
    throw new Error("INVALID_PREVIEW");
  return payload;
}
