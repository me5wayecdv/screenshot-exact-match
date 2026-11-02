/**
 * WhatsApp parent reports — CLIENT-SAFE shared helpers.
 *
 * This file contains NO secrets and NO server env reads. It is safe to
 * import from any component. The actual WhatsApp Cloud API call lives in
 * `whatsapp-api.server.ts` (server-only) and is reached only through the
 * server function in `whatsapp.functions.ts`.
 *
 * E.164: a leading "+" followed by 8–15 digits, first digit after "+"
 * non-zero (country code). Egyptian mobiles (+20 followed by 10 digits,
 * 12 digits total) pass. The same regex is enforced server-side in the
 * server function AND by a CHECK constraint in the migration — never
 * trust the client check alone.
 */

/** E.164 phone validation, shared by client form and server function. */
export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone.trim());
}

/**
 * Egyptian mobile numbers: +20 followed by 010/011/012/015 and 8 more
 * digits (12 digits total after the "+"). Enforced client-side, in the
 * server function AND by the DB CHECK constraint — never trust the
 * client check alone.
 */
export const EGYPT_MOBILE_REGEX = /^\+20(10|11|12|15)\d{8}$/;

export function isValidEgyptianMobile(phone: string): boolean {
  return EGYPT_MOBILE_REGEX.test(phone.trim());
}

/**
 * Strip spaces/dashes the user may have typed, then normalize common
 * Egyptian local forms to international +20… form:
 *   01012345678   -> +201012345678
 *   201012345678  -> +201012345678
 * Anything else is returned cleaned but unchanged, so validation can
 * reject it instead of silently inventing a wrong number.
 */
export function normalizePhoneInput(raw: string): string {
  const cleaned = raw.replace(/[\s\-()]/g, "");
  if (/^01[0125]\d{8}$/.test(cleaned)) return "+2" + cleaned;
  if (/^201[0125]\d{8}$/.test(cleaned)) return "+" + cleaned;
  return cleaned;
}

export type WhatsAppSendTrigger = "manual" | "auto";

export type WhatsAppSendStatus = "sent" | "failed" | "skipped";

/** One audit row from public.whatsapp_sends (see migration in NOTES.md). */
export type WhatsAppSendRow = {
  id: string;
  submission_id: string;
  sent_at: string;
  status: WhatsAppSendStatus;
  trigger: WhatsAppSendTrigger;
  message_id: string | null;
  error: string | null;
};

export type WhatsAppSendResult =
  | { ok: true; status: "sent"; messageId: string | null; auditSaved: boolean }
  | {
      ok: true;
      status: "skipped";
      reason: "not_configured" | "auto_disabled" | "already_sent" | "no_contact" | "no_consent";
    }
  | { ok: false; status: "failed"; error: string; auditSaved: boolean }
  | { ok: false; status: "forbidden" | "not_found" | "not_released"; error: string };
