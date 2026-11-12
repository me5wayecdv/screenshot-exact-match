/**
 * Tests for the pluggable email sender (src/server/d1-email.ts).
 *
 * All secrets/provider keys here are DUMMY values that exist only in
 * this test file — never a real key, and never committed anywhere
 * else. The tests prove: provider selection (explicit + auto-detect
 * + fail-closed), the missing-provider EMAIL_NOT_CONFIGURED error,
 * Resend request shape (key only in the Authorization header), and
 * that no token value ever appears in a return value or an error
 * message (the email body is the only place a token may live, and
 * that body is delivered, never returned or logged).
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildAuthEmail,
  resolveEmailProvider,
  sendAuthEmail,
  sendEmail,
  type SendEmailBindingLike,
} from "@/server/d1-email";

const DUMMY_RESEND_KEY = "dummy-resend-key-for-tests-only";
const DUMMY_TOKEN = "dummy-token-value-for-tests-only";

function fakeFetch(ok: boolean, status = 200) {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const fetchFn = vi.fn(async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init });
    return { ok, status } as Response;
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

function fakeSeb() {
  const sent: unknown[] = [];
  const seb: SendEmailBindingLike = {
    send: async (message: unknown) => {
      sent.push(message);
    },
  };
  return { sent, seb };
}

describe("email provider selection", () => {
  it("explicit resend wins when key + from are present", async () => {
    await expect(
      resolveEmailProvider({
        env: {
          EMAIL_PROVIDER: "resend",
          RESEND_API_KEY: DUMMY_RESEND_KEY,
          EMAIL_FROM: "Qemmini <test@example.test>",
        },
        skipWorkerEnv: true,
      }),
    ).resolves.toEqual({ name: "resend", from: "Qemmini <test@example.test>" });
  });

  it("explicit resend without a key resolves to nothing (fail closed)", async () => {
    await expect(
      resolveEmailProvider({
        env: { EMAIL_PROVIDER: "resend", EMAIL_FROM: "Qemmini <test@example.test>" },
        skipWorkerEnv: true,
      }),
    ).resolves.toBeNull();
  });

  it("explicit cloudflare wins when the binding + from are present", async () => {
    const { seb } = fakeSeb();
    await expect(
      resolveEmailProvider({
        env: { EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "Qemmini <test@example.test>" },
        seb,
        skipWorkerEnv: true,
      }),
    ).resolves.toEqual({ name: "cloudflare", from: "Qemmini <test@example.test>" });
  });

  it("mailchannels is a deprecated alias for cloudflare", async () => {
    const { seb } = fakeSeb();
    await expect(
      resolveEmailProvider({
        env: { EMAIL_PROVIDER: "mailchannels", EMAIL_FROM: "Qemmini <test@example.test>" },
        seb,
        skipWorkerEnv: true,
      }),
    ).resolves.toEqual({ name: "cloudflare", from: "Qemmini <test@example.test>" });
  });

  it("explicit cloudflare without a binding resolves to nothing", async () => {
    await expect(
      resolveEmailProvider({
        env: { EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "Qemmini <test@example.test>" },
        skipWorkerEnv: true,
      }),
    ).resolves.toBeNull();
  });

  it("an unknown EMAIL_PROVIDER resolves to nothing (fail closed)", async () => {
    await expect(
      resolveEmailProvider({
        env: {
          EMAIL_PROVIDER: "smtp",
          RESEND_API_KEY: DUMMY_RESEND_KEY,
          EMAIL_FROM: "Qemmini <test@example.test>",
        },
        skipWorkerEnv: true,
      }),
    ).resolves.toBeNull();
  });

  it("auto-detect prefers resend when its key is present", async () => {
    const { seb } = fakeSeb();
    await expect(
      resolveEmailProvider({
        env: { RESEND_API_KEY: DUMMY_RESEND_KEY, EMAIL_FROM: "Qemmini <test@example.test>" },
        seb,
        skipWorkerEnv: true,
      }),
    ).resolves.toEqual({ name: "resend", from: "Qemmini <test@example.test>" });
  });

  it("auto-detect falls back to cloudflare when only the binding exists", async () => {
    const { seb } = fakeSeb();
    await expect(
      resolveEmailProvider({
        env: { EMAIL_FROM: "Qemmini <test@example.test>" },
        seb,
        skipWorkerEnv: true,
      }),
    ).resolves.toEqual({ name: "cloudflare", from: "Qemmini <test@example.test>" });
  });

  it("no key, no binding, or no from all resolve to nothing", async () => {
    await expect(resolveEmailProvider({ env: {}, skipWorkerEnv: true })).resolves.toBeNull();
    await expect(
      resolveEmailProvider({
        env: { RESEND_API_KEY: DUMMY_RESEND_KEY },
        skipWorkerEnv: true,
      }),
    ).resolves.toBeNull();
  });
});

describe("email sending + token safety", () => {
  it("missing provider throws EMAIL_NOT_CONFIGURED (never a token fallback)", async () => {
    await expect(
      sendEmail(
        { to: "user@example.test", subject: "hi", text: `token ${DUMMY_TOKEN}` },
        { env: {}, skipWorkerEnv: true },
      ),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
  });

  it("resend posts to api.resend.com with the key only in the header", async () => {
    const { calls, fetchFn } = fakeFetch(true);
    const result = await sendEmail(
      { to: "user@example.test", subject: "Hello", text: "body" },
      {
        env: {
          RESEND_API_KEY: DUMMY_RESEND_KEY,
          EMAIL_FROM: "Qemmini <test@example.test>",
        },
        fetchFn,
        skipWorkerEnv: true,
      },
    );
    expect(result).toEqual({ ok: true, provider: "resend" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]!.init["headers"] as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${DUMMY_RESEND_KEY}`);
    const body = JSON.parse(calls[0]!.init["body"] as string) as Record<string, unknown>;
    expect(body["from"]).toBe("Qemmini <test@example.test>");
    expect(body["to"]).toEqual(["user@example.test"]);
  });

  it("a failed resend send throws EMAIL_SEND_FAILED with status only — no token", async () => {
    const { fetchFn } = fakeFetch(false, 401);
    let message = "";
    try {
      await sendAuthEmail(
        {
          to: "user@example.test",
          origin: "https://example.test",
          token: DUMMY_TOKEN,
          purpose: "reset",
        },
        {
          env: {
            RESEND_API_KEY: DUMMY_RESEND_KEY,
            EMAIL_FROM: "Qemmini <test@example.test>",
          },
          fetchFn,
          skipWorkerEnv: true,
        },
      );
    } catch (err) {
      expect((err as { code?: string }).code).toBe("EMAIL_SEND_FAILED");
      message = (err as Error).message;
    }
    expect(message).not.toContain(DUMMY_TOKEN);
    expect(message).not.toContain("user@example.test");
  });

  it("a successful send returns only ok + provider — never the token", async () => {
    const { fetchFn } = fakeFetch(true);
    const result = await sendAuthEmail(
      {
        to: "user@example.test",
        origin: "https://example.test",
        token: DUMMY_TOKEN,
        purpose: "set-password",
      },
      {
        env: {
          RESEND_API_KEY: DUMMY_RESEND_KEY,
          EMAIL_FROM: "Qemmini <test@example.test>",
        },
        fetchFn,
        skipWorkerEnv: true,
      },
    );
    expect(JSON.stringify(result)).not.toContain(DUMMY_TOKEN);
    expect(result).toEqual({ ok: true, provider: "resend" });
  });

  it("cloudflare sends through the injected binding", async () => {
    const { sent, seb } = fakeSeb();
    const result = await sendEmail(
      { to: "user@example.test", subject: "Hello", text: "body" },
      {
        env: { EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "Qemmini <test@example.test>" },
        seb,
        skipWorkerEnv: true,
      },
    );
    expect(result).toEqual({ ok: true, provider: "cloudflare" });
    expect(sent).toHaveLength(1);
  });

  it("auth email links point at the matching page per purpose", () => {
    expect(
      buildAuthEmail({
        to: "u@example.test",
        origin: "https://example.test/",
        token: DUMMY_TOKEN,
        purpose: "reset",
      }).text,
    ).toContain("https://example.test/reset-password?token=");
    expect(
      buildAuthEmail({
        to: "u@example.test",
        origin: "https://example.test",
        token: DUMMY_TOKEN,
        purpose: "set-password",
      }).text,
    ).toContain("https://example.test/set-password?token=");
  });

  it("auth emails are Arabic (subject + body), links unchanged", () => {
    const reset = buildAuthEmail({
      to: "u@example.test",
      origin: "https://example.test",
      token: DUMMY_TOKEN,
      purpose: "reset",
    });
    expect(reset.subject).toBe("استعادة كلمة سر Qemmini");
    expect(reset.text).toContain("طلبت استعادة كلمة السر");
    expect(reset.text).toContain("https://example.test/reset-password?token=");
    expect(reset.text).not.toContain("You asked to reset");
    const invite = buildAuthEmail({
      to: "u@example.test",
      origin: "https://example.test",
      token: DUMMY_TOKEN,
      purpose: "set-password",
    });
    expect(invite.subject).toBe("تعيين كلمة سر Qemmini");
    expect(invite.text).toContain("تمت دعوتك لتعيين كلمة سر");
  });

  it("sendEmail never logs: no console output on success or failure", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchFn } = fakeFetch(true);
    await sendAuthEmail(
      {
        to: "u@example.test",
        origin: "https://example.test",
        token: DUMMY_TOKEN,
        purpose: "reset",
      },
      {
        env: { RESEND_API_KEY: DUMMY_RESEND_KEY, EMAIL_FROM: "Qemmini <test@example.test>" },
        fetchFn,
        skipWorkerEnv: true,
      },
    );
    await expect(
      sendEmail(
        { to: "u@example.test", subject: "x", text: "y" },
        { env: {}, skipWorkerEnv: true },
      ),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});
