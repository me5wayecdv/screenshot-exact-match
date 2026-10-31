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
 * for assessments they own (public.owns_assessment) and students they
 * are linked to. The audit insert additionally tries the service-role
 * client first (server-side bookkeeping must not be losable to an RLS
 * edge case) and falls back to the RLS client.
 *
 * TEACHER-FINAL-WORD (deliberate, conservative reading of the spec):
 * BOTH triggers require the submission to be status='released'. The
 * manual button is the teacher's explicit action AFTER release; it can
 * never send an unreleased score. The auto path additionally requires
 * the assessment's auto_whatsapp_send toggle (default OFF).
 *
 * UNVERIFIED (coordinator must compile-check): no server-function file
 * exists yet on main to copy the exact createServerFn call shape from.
 * The shape below follows TanStack Start 1.x (createServerFn + .middleware
 * + .validator + .handler) and the repo's own auth-middleware contract
 * (context carries { supabase, userId, claims }). If the installed
 * Start version shapes context differently, adapt ONLY the context
 * access lines — the authorization logic (RLS reads + owner check)
 * must stay.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isValidEgyptianMobile, type WhatsAppSendResult } from "./whatsapp";

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
async function writeAudit(
  ctx: AuthedContext,
  row: {
    submission_id: string;
    status: "sent" | "failed" | "skipped";
    trigger: "manual" | "auto";
    message_id: string | null;
    error: string | null;
  },
): Promise<boolean> {
  // Preferred: service-role client (bypasses RLS, audit is append-only
  // server bookkeeping). Falls back to the caller's RLS client, whose
  // whatsapp_sends insert policy allows teachers of own assessments.
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("whatsapp_sends").insert(row);
    if (!error) return true;
  } catch {
    // Service-role env missing in this deployment — fall through to RLS.
  }
  const { error } = await ctx.supabase.from("whatsapp_sends").insert(row);
  return !error;
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

    // 4. Auto path: toggle must be ON (default OFF) and a previous
    // successful send must not already exist (release happens once,
    // but a retried release call must not double-send).
    if (trigger === "auto") {
      if (!assessment.auto_whatsapp_send)
        return { ok: true, status: "skipped", reason: "auto_disabled" };
      const { data: prior } = await ctx.supabase
        .from("whatsapp_sends")
        .select("id")
        .eq("submission_id", submissionId)
        .eq("status", "sent")
        .limit(1);
      if (prior && prior.length > 0) return { ok: true, status: "skipped", reason: "already_sent" };
    }

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
    if (!isValidEgyptianMobile(phone)) {
      const auditSaved = await writeAudit(ctx, {
        submission_id: submissionId,
        status: "failed",
        trigger,
        message_id: null,
        error: "invalid_phone",
      });
      return { ok: false, status: "failed", error: "invalid_phone", auditSaved };
    }

    // 6. Server-only send. Dynamic import keeps the token module out of
    // the client bundle; the API module itself refuses when env is unset.
    const api = await import("./whatsapp-api.server");
    const scoreText = `${Number(sub.final_score ?? 0)}/${Number(sub.total_possible ?? 0)}`;
    const result = await api.sendWhatsAppTemplate(phone, {
      studentName: profile?.full_name || "",
      assessmentTitle: assessment.title,
      scoreText,
    });
    if (!result.configured) return { ok: true, status: "skipped", reason: "not_configured" };

    const auditSaved = await writeAudit(ctx, {
      submission_id: submissionId,
      status: result.ok ? "sent" : "failed",
      trigger,
      message_id: result.ok ? result.messageId : null,
      error: result.ok ? null : result.error,
    });
    if (!result.ok) return { ok: false, status: "failed", error: result.error, auditSaved };
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
