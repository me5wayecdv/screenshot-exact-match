/**
 * WhatsApp Cloud API — SERVER-ONLY module (note the `.server.ts` suffix).
 *
 * SECURITY RULES (do not relax them):
 * - NEVER import this file from a component, route file, or any other
 *   client-bundled module. It is imported ONLY via dynamic import inside
 *   the server-function handler in `whatsapp.functions.ts`, following the
 *   same pattern the repo documents for `client.server.ts` ("Load inside
 *   server handlers").
 * - WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are read ONLY from
 *   server env (process.env). They are NEVER stored in code, in the
 *   repo, in the database, or in any client-visible response. If either
 *   is unset, sending is refused with `configured: false` — the UI then
 *   shows "WhatsApp not connected", never a silent failure.
 * - The token is sent ONLY to graph.facebook.com, in the Authorization
 *   header, and is never logged.
 */

// ---------------------------------------------------------------------------
// TEMPLATE — READ BEFORE CHANGING ANYTHING HERE
// ---------------------------------------------------------------------------
// Template name (constant): "result_report".
//
// META-APPROVAL CAVEAT — sending will FAIL until ALL of the following are
// true in Meta's WhatsApp Manager dashboard for this phone number:
//   1. A template named exactly `result_report` exists and is APPROVED
//      (a template in review / rejected / paused returns an error from
//      the API; the error is recorded in public.whatsapp_sends.error).
//   2. The approved template body has EXACTLY THREE body parameters, in
//      THIS order: (1) student name, (2) assessment title, (3) score
//      text (e.g. "8/10"). If the approved body has a different number
//      of parameters, a different order, or header/footer parameters,
//      the parameters below MUST be changed to match it — the API
//      rejects mismatched templates.
//   3. The template's language matches WHATSAPP_TEMPLATE_LANGUAGE below.
//      "ar" is used here (Arabic-first product); if the approved template
//      was created in another language, change this constant to that
//      language code instead of guessing.
// No real Meta template body is invented here: the body text lives ONLY
// in Meta's dashboard, never in this codebase.
// ---------------------------------------------------------------------------
export const WHATSAPP_TEMPLATE_NAME = "result_report";
export const WHATSAPP_TEMPLATE_LANGUAGE = "ar";

const GRAPH_API_VERSION = "v21.0";

export type WhatsAppTemplateParams = {
  /** (1) Student full name, as shown on the report. */
  studentName: string;
  /** (2) Assessment title. */
  assessmentTitle: string;
  /** (3) Score text, e.g. "8/10". Built by the server function from the
   *  teacher-released final_score / total_possible — never from client
   *  input, so a caller cannot forge a score. */
  scoreText: string;
};

export type WhatsAppApiResult =
  | { configured: true; ok: true; messageId: string | null }
  | { configured: true; ok: false; error: string }
  | { configured: false; ok: false; error: string };

function readServerEnv(name: string): string | undefined {
  if (typeof process !== "undefined") return process.env[name];
  return undefined;
}

/** True when both server env vars are present. Used for the UI's
 *  "WhatsApp not connected" state; never reveals which var is missing. */
export function isWhatsAppConfigured(): boolean {
  return Boolean(readServerEnv("WHATSAPP_TOKEN") && readServerEnv("WHATSAPP_PHONE_NUMBER_ID"));
}

/**
 * Send one approved-template message via the WhatsApp Cloud API.
 * `to` must already be E.164-validated by the caller (server function
 * re-validates; this function validates again as defence in depth).
 */
export async function sendWhatsAppTemplate(
  to: string,
  params: WhatsAppTemplateParams,
): Promise<WhatsAppApiResult> {
  const token = readServerEnv("WHATSAPP_TOKEN");
  const phoneNumberId = readServerEnv("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    return { configured: false, ok: false, error: "whatsapp_not_configured" };
  }
  if (!/^\+[1-9]\d{7,14}$/.test(to.trim())) {
    return { configured: true, ok: false, error: "invalid_phone" };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        // The token travels ONLY in this header, ONLY to graph.facebook.com.
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Stored format is E.164 WITH "+"; the Cloud API `to` field is
        // sent as digits only (the "+" is stripped here, at the API
        // boundary only — the DB value keeps its "+"). If Meta rejects
        // a number, the error lands in whatsapp_sends.error; see NOTES.md
        // "unverified" for this formatting assumption.
        to: to.trim().replace(/^\+/, ""),
        type: "template",
        template: {
          name: WHATSAPP_TEMPLATE_NAME,
          language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: params.studentName },
                { type: "text", text: params.assessmentTitle },
                { type: "text", text: params.scoreText },
              ],
            },
          ],
        },
      }),
    });
  } catch (e) {
    // Network failure: never include the token or the raw request.
    return { configured: true, ok: false, error: e instanceof Error ? e.message.slice(0, 500) : "network_error" };
  }

  const body = (await res.json().catch(() => null)) as {
    messages?: { id: string }[];
    error?: { message?: string; code?: number; error_subcode?: number };
  } | null;

  if (!res.ok) {
    // Meta's error message (e.g. template not approved / not found) is
    // safe to store: it contains no token. It IS what the teacher sees
    // in the audit row, so a misconfigured template is visible, not silent.
    const detail = body?.error?.message ?? `whatsapp_http_${res.status}`;
    return { configured: true, ok: false, error: String(detail).slice(0, 500) };
  }
  return { configured: true, ok: true, messageId: body?.messages?.[0]?.id ?? null };
}
