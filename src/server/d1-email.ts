/**
 * Pluggable email sender for the Cloudflare-only Worker (cutover gap #1).
 *
 * SERVER-ONLY: never import from a component or route file. It is used
 * by server functions only (password reset, set-password invitation).
 *
 * Providers (selected by EMAIL_PROVIDER, or auto-detected when unset):
 * - "resend": Resend HTTP API. Needs secrets/vars RESEND_API_KEY (set
 *   with `wrangler secret put`, NEVER committed) + EMAIL_FROM (a
 *   verified sender on a verified domain, set in wrangler.jsonc vars).
 * - "cloudflare": Cloudflare Email Service via the `send_email`
 *   binding (SEB in wrangler.jsonc) — the native Workers way to send,
 *   no API key. Needs EMAIL_FROM on a domain onboarded to Email
 *   Service, with SPF/DKIM DNS in the Cloudflare dashboard. The
 *   binding is only reachable inside a Worker; outside one the
 *   provider resolves to "not configured", never to a fallback that
 *   prints a token.
 * - "mailchannels": deprecated alias for "cloudflare" (same binding).
 *   MailChannels' free Workers integration ended in August 2024; the
 *   `send_email` binding now speaks Cloudflare Email Service. The
 *   alias stays so an old EMAIL_PROVIDER value keeps working.
 *
 * Token safety (do not weaken):
 * - The raw reset/set-password token appears ONLY inside the email
 *   body sent to the account's own address — that is the delivery
 *   channel, and it is the only place it may appear.
 * - It is NEVER returned in a server-function response, NEVER logged,
 *   and NEVER included in an error message. sendEmail() returns only
 *   { ok, provider }; failures carry only the provider name + HTTP
 *   status, never the recipient, subject, or body.
 * - If no provider is configured, sendEmail() throws
 *   EMAIL_NOT_CONFIGURED. Callers check configuration BEFORE issuing
 *   a token, so the error is identical for known and unknown emails
 *   (no account-enumeration signal) and no orphan token is created.
 * - There is deliberately NO fallback that prints, logs, or returns
 *   the token when email is unconfigured.
 */

import { getWorkerEnv, type SendEmailBindingLike } from "@/server/d1";

export type { SendEmailBindingLike };

export class EmailError extends Error {
  constructor(
    public readonly code: "EMAIL_NOT_CONFIGURED" | "EMAIL_SEND_FAILED" | "INVALID_EMAIL",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "EmailError";
  }
}

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type EmailProviderName = "resend" | "cloudflare";

export type ResolvedEmailProvider = {
  name: EmailProviderName;
  from: string;
};

export type EmailDeps = {
  /** Test/override env. Production reads process.env (see readServerEnv). */
  env?: Record<string, string | undefined>;
  /** Injected Cloudflare Email Service binding (tests, or a Worker env override). */
  seb?: SendEmailBindingLike | null;
  /** Injected fetch (tests). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Skip the Worker-env lookup (tests run outside a Worker). */
  skipWorkerEnv?: boolean;
};

function readServerEnv(name: string, override?: Record<string, string | undefined>): string {
  if (override && override[name] !== undefined) return override[name].trim();
  if (typeof process !== "undefined" && process.env[name]) return process.env[name].trim();
  return "";
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Resolves the configured provider, or null when none is usable.
 * An explicitly named provider that is missing its key/binding/from
 * resolves to null (fail closed) — it never falls through to another
 * provider, because a half-configured provider must surface as
 * EMAIL_NOT_CONFIGURED, not silently send from the wrong sender.
 */
export async function resolveEmailProvider(
  deps: EmailDeps = {},
): Promise<ResolvedEmailProvider | null> {
  const provider = readServerEnv("EMAIL_PROVIDER", deps.env).toLowerCase();
  const from = readServerEnv("EMAIL_FROM", deps.env);
  const resendKey = readServerEnv("RESEND_API_KEY", deps.env);
  let seb = deps.seb ?? null;
  if (!seb && !deps.skipWorkerEnv) {
    try {
      const env = await getWorkerEnv();
      seb = env?.SEB ?? null;
    } catch {
      seb = null;
    }
  }
  if (!from) return null;
  if (provider === "resend") return resendKey ? { name: "resend", from } : null;
  // "cloudflare" is the canonical name for the send_email binding;
  // "mailchannels" is its deprecated alias (same binding, same path).
  if (provider === "cloudflare" || provider === "mailchannels")
    return seb ? { name: "cloudflare", from } : null;
  if (provider !== "") return null; // Unknown EMAIL_PROVIDER: fail closed.
  if (resendKey) return { name: "resend", from };
  if (seb) return { name: "cloudflare", from };
  return null;
}

/** Throws EMAIL_NOT_CONFIGURED unless a provider resolves. */
export async function assertEmailConfigured(deps: EmailDeps = {}): Promise<ResolvedEmailProvider> {
  const provider = await resolveEmailProvider(deps);
  if (!provider) throw new EmailError("EMAIL_NOT_CONFIGURED", "Email is not configured.");
  return provider;
}

function buildRfc822(from: string, to: string, subject: string, text: string): string {
  // Minimal plain-text RFC 822 message for the send_email binding.
  // Header values come from server config / the account's own address
  // only — never from untrusted caller input beyond the validated `to`.
  const safeSubject = subject.replace(/[\r\n]+/g, " ");
  return (
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${safeSubject}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n${text}`
  );
}

async function sendViaResend(
  message: EmailMessage,
  provider: ResolvedEmailProvider,
  deps: EmailDeps,
): Promise<void> {
  const apiKey = readServerEnv("RESEND_API_KEY", deps.env);
  if (!apiKey) throw new EmailError("EMAIL_NOT_CONFIGURED", "Email is not configured.");
  const fetchFn = deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        // The key travels ONLY in this header, ONLY to api.resend.com.
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: provider.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
  } catch {
    throw new EmailError("EMAIL_SEND_FAILED", "Email send failed (resend).");
  }
  if (!res.ok) {
    // Status only: the provider error body is never surfaced, so it
    // can never echo the message (or anything inside it) back.
    throw new EmailError("EMAIL_SEND_FAILED", `Email send failed (resend, ${res.status}).`);
  }
}

async function sendViaCloudflare(
  message: EmailMessage,
  provider: ResolvedEmailProvider,
  deps: EmailDeps,
): Promise<void> {
  let seb = deps.seb ?? null;
  if (!seb && !deps.skipWorkerEnv) {
    try {
      seb = (await getWorkerEnv())?.SEB ?? null;
    } catch {
      seb = null;
    }
  }
  if (!seb) throw new EmailError("EMAIL_NOT_CONFIGURED", "Email is not configured.");
  const raw = buildRfc822(provider.from, message.to, message.subject, message.text);
  try {
    const EmailMessageCtor = (globalThis as unknown as { EmailMessage?: unknown }).EmailMessage as
      (new (from: string, to: string, raw: string) => unknown) | undefined;
    // Inside a Worker, send the real EmailMessage. Outside one (tests),
    // the injected binding receives the plain message instead.
    const wire = EmailMessageCtor
      ? new EmailMessageCtor(provider.from, message.to, raw)
      : { from: provider.from, to: message.to, subject: message.subject, text: message.text, raw };
    await seb.send(wire);
  } catch (err) {
    if (err instanceof EmailError) throw err;
    throw new EmailError("EMAIL_SEND_FAILED", "Email send failed (cloudflare).");
  }
}

/**
 * Single entry point for all server-side email. Returns only the
 * provider name — never the message, recipient, or any token the
 * caller put inside the message body.
 */
export async function sendEmail(
  message: EmailMessage,
  deps: EmailDeps = {},
): Promise<{ ok: true; provider: EmailProviderName }> {
  if (!isValidEmail(message.to)) throw new EmailError("INVALID_EMAIL", "Invalid email address.");
  const provider = await assertEmailConfigured(deps);
  if (provider.name === "resend") await sendViaResend(message, provider, deps);
  else await sendViaCloudflare(message, provider, deps);
  return { ok: true, provider: provider.name };
}

export type AuthEmailPurpose = "reset" | "set-password";

/**
 * Builds the reset / set-password email for a token. The token is
 * embedded ONLY in the link inside this email body (the delivery
 * channel). Callers must never put this return value in a response
 * or a log — they pass it straight to sendEmail().
 */
export function buildAuthEmail(input: {
  to: string;
  origin: string;
  token: string;
  purpose: AuthEmailPurpose;
}): EmailMessage {
  const path = input.purpose === "set-password" ? "/set-password" : "/reset-password";
  const link = `${input.origin.replace(/\/+$/, "")}${path}?token=${encodeURIComponent(input.token)}`;
  const isSetPassword = input.purpose === "set-password";
  // Arabic-first product: auth emails are Arabic. The link mechanics
  // are unchanged — the token lives only in this body.
  return {
    to: input.to,
    subject: isSetPassword ? "تعيين كلمة سر Qemmini" : "استعادة كلمة سر Qemmini",
    text:
      (isSetPassword
        ? "تمت دعوتك لتعيين كلمة سر لحسابك في Qemmini.\n\n"
        : "طلبت استعادة كلمة السر لحسابك في Qemmini.\n\n") +
      `افتح الرابط ده لتعيين كلمة سر جديدة:\n${link}\n\n` +
      "الرابط صالح لمدة ساعة واحدة ويُستخدم مرة واحدة. " +
      "بعد تعيين كلمة السر الجديدة، سيتم تسجيل خروج كل الجلسات القديمة.\n" +
      "إذا لم تطلب هذا، تجاهل الرسالة.",
  };
}

/** Convenience wrapper: build + send an auth email in one call. */
export async function sendAuthEmail(
  input: { to: string; origin: string; token: string; purpose: AuthEmailPurpose },
  deps: EmailDeps = {},
): Promise<{ ok: true; provider: EmailProviderName }> {
  return sendEmail(buildAuthEmail(input), deps);
}
