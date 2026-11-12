/**
 * Shared zod input schemas — auth pilot (first zod migration).
 *
 * The audit found validation is manual: `.validator()` casts in
 * ~125 places pass data through, and the real checks live in
 * src/lib/cloudflare-auth.ts (signUp / signIn). These schemas move
 * the auth-input checks to the server-function boundary so a bad
 * payload fails with the SAME AuthError code signUp/signIn would
 * throw. The downstream manual checks stay in place as
 * defense-in-depth; the schemas do not replace them, they front them.
 *
 * Rules mirror cloudflare-auth.ts exactly — a valid input today
 * stays valid, an invalid one stays invalid:
 * - email: trimmed + lowercased, then /^[^\s@]+@[^\s@]+\.[^\s@]+$/
 *   (same pattern as isValidEmail in cloudflare-auth.ts).
 * - password: at least MIN_PASSWORD_LENGTH (8) characters, NOT trimmed
 *   (signUp checks the raw length).
 * - fullName: trimmed, must be non-empty. The form marks it required,
 *   but the server never checked it — an empty name was stored as "".
 *   The zod check fronts this; signUp also rejects it (INVALID_INPUT)
 *   as defense-in-depth.
 * - role: exactly "school_teacher" | "tutor" | "student".
 * - teacher roles: teacherPhone required, normalized with
 *   normalizePhoneInput (local 010… / 201… forms -> +20…), then it
 *   must be a valid Egyptian mobile (+20 + 010/011/012/015 + 8 digits).
 *   Students: teacherPhone is ignored entirely (stored null today).
 * - sign-in has NO format rules today: any string email/password
 *   reaches the lookup and a miss becomes INVALID_CREDENTIALS. The
 *   sign-in schema only enforces the types, so a malformed payload
 *   fails cleanly instead of crashing inside normalizeEmail.
 *
 * This module is imported by d1-auth-fns.ts, which client routes
 * import — so it must stay client-safe: zod + whatsapp.ts (marked
 * client-safe) + AuthError/MIN_PASSWORD_LENGTH from cloudflare-auth.ts
 * (already in that import graph). No server-only imports.
 */
import { z } from "zod";
import { AuthError, MIN_PASSWORD_LENGTH } from "@/lib/cloudflare-auth";
import { isValidEgyptianMobile, normalizePhoneInput } from "@/lib/whatsapp";

/** Same pattern as isValidEmail in cloudflare-auth.ts. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const signUpSchema = z
  .object({
    email: z.string().trim().toLowerCase().regex(EMAIL_REGEX),
    password: z.string().min(MIN_PASSWORD_LENGTH),
    role: z.enum(["school_teacher", "tutor", "student"]),
    fullName: z.string().trim().min(1),
    parentPhone: z.string().nullish(),
    teacherPhone: z.string().nullish(),
    subjects: z.string().nullish(),
    school: z.string().nullish(),
  })
  .superRefine((data, ctx) => {
    // Teacher phone rule, same as signUp in cloudflare-auth.ts:
    // normalize local forms first, then require a valid Egyptian mobile.
    if (data.role === "school_teacher" || data.role === "tutor") {
      const phone = normalizePhoneInput(data.teacherPhone ?? "");
      if (!isValidEgyptianMobile(phone)) {
        ctx.addIssue({
          code: "custom",
          path: ["teacherPhone"],
          message: "A valid Egyptian mobile is required for teachers.",
        });
      }
    }
  });

export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: z.string(),
  password: z.string(),
});

export type SignInInput = z.infer<typeof signInSchema>;

/**
 * Map a sign-up schema failure to the AuthError signUp would throw
 * for the same input. Priority follows signUp's check order
 * (email -> password -> role -> phone), so a doubly-invalid payload
 * fails with the same code it does today. Anything with no AuthError
 * equivalent (e.g. a missing fullName, a non-string parentPhone —
 * inputs that crash inside signUp today) becomes a plain
 * INVALID_INPUT error instead of a TypeError.
 */
export function signUpValidationError(error: z.ZodError): Error {
  const paths = new Set(error.issues.map((issue) => issue.path[0]));
  if (paths.has("email")) return new AuthError("INVALID_EMAIL");
  if (paths.has("password")) return new AuthError("WEAK_PASSWORD");
  if (paths.has("role")) return new AuthError("INVALID_ROLE");
  if (paths.has("teacherPhone")) {
    return new AuthError("INVALID_PHONE");
  }
  return new Error("INVALID_INPUT");
}

/** Parse sign-up input or throw the matching AuthError. */
export function validateSignUpInput(data: unknown): SignUpInput {
  const parsed = signUpSchema.safeParse(data);
  if (!parsed.success) throw signUpValidationError(parsed.error);
  return parsed.data;
}

/** Parse sign-in input; any malformed payload is INVALID_CREDENTIALS. */
export function validateSignInInput(data: unknown): SignInInput {
  const parsed = signInSchema.safeParse(data);
  if (!parsed.success) throw new AuthError("INVALID_CREDENTIALS");
  return parsed.data;
}
