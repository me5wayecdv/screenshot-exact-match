/**
 * WhatsApp parent reports — server functions (TanStack Start).
 *
 * NEVER browser-side: the WhatsApp token is read only inside
 * `whatsapp-api.server.ts`, which this file reaches ONLY via dynamic
 * import inside the handler (same pattern the repo documents for
 * `client.server.ts`). Nothing in this file, and nothing it returns,
 * ever contains a token.
 *
 * Auth: `requireSupabaseAuth` (src/integrations/supabase/auth-middleware.ts)
 * attaches the caller's Bearer token; the handler then uses that RLS
 * client (`context.supabase`) for every read, so a teacher can only send
 * for assessments they own (public.owns_assessment). Audit writes use the
 * service-role client only; clients cannot forge delivery outcomes.
 *
 * TEACHER-FINAL-WORD (deliberate, conservative reading of the spec):
 * BOTH triggers require the submission to be status='released'. The
 * manual button is the teacher's explicit action AFTER release; it can
 * never send an unreleased score. The auto path additionally requires
 * the assessment's auto_whatsapp_send toggle (default OFF).
 *
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isValidE164, type WhatsAppSendResult } from "./whatsapp";

type AuthedContext = {
  supabase: import("@supabase/supabase-js").SupabaseClient;
  userId: string;
};

function badInput(message: string): Error {
  return new Error(message);
}

type SendInput = { submissionId: string; trigger: "manual" | "auto" };

function validateSendInput(data: unknown): SendInput {
  const d = data as Partial<SendInput> | null;
  if (!d || typeof d.submissionId !== "string" || !d.submissionId)
    throw badInput("submissionId required");
  if (d.trigger !== "manual" && d.trigger !== "auto")
    throw badInput("trigger must be manual or auto");
  return { submissionId: d.submissionId, trigger: d.trigger };
}

/** Insert one audit row. Never throws: a failed audit write must not
 *  rewrite the send outcome (the caller reports auditSaved: false). */
async function writeAudit(row: {
  submission_id: string;
  status: "sent" | "failed" | "skipped";
  trigger: "manual" | "auto";
  message_id: string | null;
  error: string | null;
}): Promise<boolean> {
  // Audit writes are server-only. Allowing client INSERT would let a teacher
  // forge a "sent" row and suppress a later automatic notification.
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("whatsapp_sends").insert(row);
    return !error;
  } catch {
    return false;
  }
}

async function claimSend(submissionId: string): Promise<"claimed" | "duplicate" | "error"> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("claim_whatsapp_send", {
      _submission: submissionId,
    });
    if (error) return "error";
    return data ? "claimed" : "duplicate";
  } catch {
    return "error";
  }
}

async function finishSend(
  submissionId: string,
  status: "sent" | "failed" | "skipped",
  trigger: "manual" | "auto",
  messageId: string | null,
  errorMessage: string | null,
  retryable = false,
): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("finish_whatsapp_send", {
      _submission: submissionId,
      _status: status,
      _trigger: trigger,
      _message_id: messageId,
      _error: errorMessage,
      _retryable: retryable,
    });
    return !error && data === true;
  } catch {
    // The claim lease prevents an immediate duplicate while the DB is unavailable.
    return false;
  }
}

export const sendWhatsAppReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(validateSendInput)
  .handler(async ({ data, context }): Promise<WhatsAppSendResult> => {
    const ctx = context as unknown as AuthedContext;
    const { submissionId, trigger } = data;

    // 1. Submission via the caller's RLS client: invisible rows (another
    // teacher's, or a non-existent id) both surface as not_found, so
    // existence is never leaked to a non-owner.
    const { data: sub } = await ctx.supabase
      .from("submissions")
      .select("id, assessment_id, student_id, status, final_score, total_possible")
      .eq("id", submissionId)
      .maybeSingle();
    if (!sub) return { ok: false, status: "not_found", error: "submission_not_found" };

    // 2. Owner check (belt and braces over the RLS policies).
    const { data: assessment } = await ctx.supabase
      .from("assessments")
      .select("id, title, teacher_id, auto_whatsapp_send")
      .eq("id", sub.assessment_id)
      .maybeSingle();
    if (!assessment) return { ok: false, status: "not_found", error: "assessment_not_found" };
    if (assessment.teacher_id !== ctx.userId)
      return { ok: false, status: "forbidden", error: "not_assessment_owner" };

    // 3. Teacher-final-word: never send an unreleased submission.
    if (sub.status !== "released")
      return { ok: false, status: "not_released", error: "submission_not_released" };

    // 4. Auto path: the toggle is checked here, then a database uniqueness
    // claim is acquired after contact/consent checks and before the network call.
    if (trigger === "auto" && !assessment.auto_whatsapp_send)
      return { ok: true, status: "skipped", reason: "auto_disabled" };

    // 5. Parent contact, via RLS (teacher reads linked student profiles
    // under the existing "read own profile" policy pattern).
    const { data: profile } = await ctx.supabase
      .from("profiles")
      .select("full_name, parent_phone, whatsapp_consent")
      .eq("id", sub.student_id)
      .maybeSingle();
    const phone = (profile?.parent_phone ?? null) as string | null;
    const consent = (profile?.whatsapp_consent ?? false) as boolean;
    if (!phone) return { ok: true, status: "skipped", reason: "no_contact" };
    if (!consent) return { ok: true, status: "skipped", reason: "no_consent" };
    if (!isValidE164(phone)) {
      const auditSaved = await writeAudit({
        submission_id: submissionId,
        status: "failed",
        trigger,
        message_id: null,
        error: "invalid_phone",
      });
      return { ok: false, status: "failed", error: "invalid_phone", auditSaved };
    }

    const api = await import("./whatsapp-api.server");
    if (!api.isWhatsAppConfigured()) {
      await writeAudit({
        submission_id: submissionId,
        status: "skipped",
        trigger,
        message_id: null,
        error: "not_configured",
      });
      return { ok: true, status: "skipped", reason: "not_configured" };
    }

    const claim = await claimSend(submissionId);
    if (claim === "duplicate") return { ok: true, status: "skipped", reason: "already_sent" };
    if (claim === "error") {
      const auditSaved = await writeAudit({
        submission_id: submissionId,
        status: "failed",
        trigger,
        message_id: null,
        error: "send_claim_failed",
      });
      return { ok: false, status: "failed", error: "send_claim_failed", auditSaved };
    }

    // 6. The DB atomically records the outcome and finalizes/releases the claim.
    let result: Awaited<ReturnType<typeof api.sendWhatsAppTemplate>>;
    try {
      const scoreText = `${Number(sub.final_score ?? 0)}/${Number(sub.total_possible ?? 0)}`;
      result = await api.sendWhatsAppTemplate(phone, {
        studentName: profile?.full_name || "",
        assessmentTitle: assessment.title,
        scoreText,
      });
    } catch {
      // The provider may have accepted the message before the connection failed.
      // Preserve the claim to prevent a blind retry from sending a duplicate.
      const auditSaved = await finishSend(
        submissionId,
        "failed",
        trigger,
        null,
        "network_outcome_unknown",
        false,
      );
      return { ok: false, status: "failed", error: "whatsapp_send_failed", auditSaved };
    }
    if (!result.configured) {
      await finishSend(submissionId, "skipped", trigger, null, "not_configured", false);
      return { ok: true, status: "skipped", reason: "not_configured" };
    }
    if (!result.ok) {
      const auditSaved = await finishSend(
        submissionId,
        "failed",
        trigger,
        null,
        result.error,
        true,
      );
      return { ok: false, status: "failed", error: result.error, auditSaved };
    }
    const auditSaved = await finishSend(
      submissionId,
      "sent",
      trigger,
      result.messageId,
      null,
      false,
    );
    return { ok: true, status: "sent", messageId: result.messageId, auditSaved };
  });

/** UI gate: is WhatsApp connected on the server? Returns false (not an
 *  error) when env is unset, so components render "WhatsApp not
 *  connected" instead of failing. Still requires auth, so the answer is
 *  never public. */
export const getWhatsAppConfigured = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ configured: boolean }> => {
    const api = await import("./whatsapp-api.server");
    return { configured: api.isWhatsAppConfigured() };
  });
