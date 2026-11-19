/**
 * Tests for the zod auth schemas (src/lib/validation.ts) — the pilot
 * of the zod migration. Every case mirrors the manual checks in
 * src/lib/cloudflare-auth.ts signUp/signIn: a valid input today must
 * parse, an invalid one must throw the same AuthError code signUp
 * would throw. Phone cases cover the exact formats
 * normalizePhoneInput + isValidEgyptianMobile accept/reject.
 *
 * A student's parent phone is REQUIRED (the exam report goes to the
 * parent): a missing number is PARENT_PHONE_REQUIRED, a malformed one
 * is INVALID_PHONE.
 */
import { describe, expect, it } from "vitest";
import { AuthError } from "@/lib/cloudflare-auth";
import {
  signInSchema,
  signUpSchema,
  validateSignInInput,
  validateSignUpInput,
} from "@/lib/validation";

/** The AuthError code (or plain message) a call throws, else "NO_THROW". */
function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuthError) return e.code;
    return (e as Error).message;
  }
  return "NO_THROW";
}

const validTeacher = {
  email: "teacher@example.com",
  password: "12345678",
  fullName: "Test Teacher",
  role: "tutor",
  teacherPhone: "01012345678",
};

const validStudent = {
  email: "student@example.com",
  password: "12345678",
  fullName: "Test Student",
  role: "student",
  parentPhone: "01012345678",
};

describe("signUpSchema — valid inputs", () => {
  it("parses a valid teacher sign-up and normalizes the email", () => {
    const parsed = signUpSchema.parse({ ...validTeacher, email: "  Teacher@Example.COM " });
    expect(parsed.email).toBe("teacher@example.com");
    expect(parsed.role).toBe("tutor");
    // The schema validates the phone; normalization to +20… stays in
    // signUp downstream, so the raw value passes through here.
    expect(parsed.teacherPhone).toBe("01012345678");
  });

  it("parses a valid student sign-up with a parent phone", () => {
    const parsed = signUpSchema.parse(validStudent);
    expect(parsed.parentPhone).toBe("01012345678");
    expect(parsed.teacherPhone).toBeUndefined();
  });

  it("ignores teacherPhone for students, even when it is garbage", () => {
    expect(signUpSchema.parse({ ...validStudent, teacherPhone: "not-a-phone" })).toBeTruthy();
  });

  it.each([
    "01012345678",
    "01112345678",
    "01212345678",
    "01512345678",
    "+201012345678",
    "201012345678",
    "010 1234 5678",
    "(010) 1234-5678",
    "010-1234-5678",
  ])("accepts teacher phone %s", (teacherPhone) => {
    expect(signUpSchema.parse({ ...validTeacher, teacherPhone })).toBeTruthy();
  });

  it.each([
    "01012345678",
    "01112345678",
    "01212345678",
    "01512345678",
    "+201012345678",
    "201012345678",
    "010 1234 5678",
    "(010) 1234-5678",
    "010-1234-5678",
  ])("accepts student parent phone %s", (parentPhone) => {
    expect(signUpSchema.parse({ ...validStudent, parentPhone })).toBeTruthy();
  });

  it("accepts a password of exactly 8 characters", () => {
    expect(signUpSchema.parse({ ...validTeacher, password: "12345678" })).toBeTruthy();
  });

  it("does NOT trim the password (signUp checks the raw length)", () => {
    // 8 chars including the leading space: valid today, stays valid.
    expect(signUpSchema.parse({ ...validTeacher, password: " 1234567" })).toBeTruthy();
  });

  it("accepts an ASCII password mixing letters, digits, and symbols", () => {
    expect(signUpSchema.parse({ ...validTeacher, password: "Teach3r!_pass" })).toBeTruthy();
  });

  it("accepts null/omitted optional fields", () => {
    expect(
      signUpSchema.parse({
        ...validTeacher,
        subjects: null,
        school: null,
      }),
    ).toBeTruthy();
  });

  it("strips unknown extra keys", () => {
    const parsed = signUpSchema.parse({ ...validStudent, injected: "x" });
    expect("injected" in parsed).toBe(false);
  });
});

describe("signUpSchema — invalid inputs", () => {
  it.each(["not-an-email", "a@b", "a b@c.com", "", "a@@b.com"])(
    "rejects email %s as INVALID_EMAIL",
    (email) => {
      expect(thrownCode(() => validateSignUpInput({ ...validTeacher, email }))).toBe(
        "INVALID_EMAIL",
      );
    },
  );

  it("rejects a 7-character password as WEAK_PASSWORD", () => {
    expect(thrownCode(() => validateSignUpInput({ ...validTeacher, password: "1234567" }))).toBe(
      "WEAK_PASSWORD",
    );
  });

  it("rejects a password with Arabic characters as PASSWORD_NOT_LATIN", () => {
    expect(
      thrownCode(() => validateSignUpInput({ ...validTeacher, password: "كلمةالسر123" })),
    ).toBe("PASSWORD_NOT_LATIN");
  });

  it("rejects a short Arabic password as WEAK_PASSWORD (length wins, same as signUp)", () => {
    expect(thrownCode(() => validateSignUpInput({ ...validTeacher, password: "قصيرة" }))).toBe(
      "WEAK_PASSWORD",
    );
  });

  it.each(["admin", "school", "", 123, null])("rejects role %s as INVALID_ROLE", (role) => {
    expect(thrownCode(() => validateSignUpInput({ ...validTeacher, role }))).toBe("INVALID_ROLE");
  });

  it.each([
    ["missing teacherPhone", {}],
    ["empty teacherPhone", { teacherPhone: "" }],
    ["10-digit local number", { teacherPhone: "0101234567" }],
    ["12-digit local number", { teacherPhone: "010123456789" }],
    ["019 prefix", { teacherPhone: "01912345678" }],
    ["+20 019 prefix", { teacherPhone: "+201912345678" }],
    ["short number", { teacherPhone: "12345" }],
    ["wrong country code", { teacherPhone: "+2101012345678" }],
    ["letter in number", { teacherPhone: "0101234567a" }],
  ])("rejects teacher phone (%s) as INVALID_PHONE", (_label, patch) => {
    const input = { ...validTeacher, teacherPhone: "01012345678", ...patch };
    if (!("teacherPhone" in patch)) delete (input as Record<string, unknown>)["teacherPhone"];
    expect(thrownCode(() => validateSignUpInput(input))).toBe("INVALID_PHONE");
  });

  it("requires a parent phone for students (the report goes to the parent)", () => {
    const { parentPhone: _omitted, ...rest } = validStudent;
    expect(thrownCode(() => validateSignUpInput(rest))).toBe("PARENT_PHONE_REQUIRED");
    expect(thrownCode(() => validateSignUpInput({ ...rest, parentPhone: "" }))).toBe(
      "PARENT_PHONE_REQUIRED",
    );
    expect(thrownCode(() => validateSignUpInput({ ...rest, parentPhone: null }))).toBe(
      "PARENT_PHONE_REQUIRED",
    );
    expect(thrownCode(() => validateSignUpInput({ ...rest, parentPhone: "   " }))).toBe(
      "PARENT_PHONE_REQUIRED",
    );
  });

  it.each([
    ["10-digit local number", "0101234567"],
    ["12-digit local number", "010123456789"],
    ["019 prefix", "01912345678"],
    ["+20 019 prefix", "+201912345678"],
    ["short number", "12345"],
    ["wrong country code", "+2101012345678"],
    ["letter in number", "0101234567a"],
    ["US number", "+15551234567"],
  ])("rejects student parent phone (%s) as INVALID_PHONE", (_label, parentPhone) => {
    expect(thrownCode(() => validateSignUpInput({ ...validStudent, parentPhone }))).toBe(
      "INVALID_PHONE",
    );
  });

  it("keeps signUp's check priority on doubly-invalid payloads", () => {
    // email beats phone, password beats role, role beats phone.
    expect(
      thrownCode(() => validateSignUpInput({ ...validTeacher, email: "bad", teacherPhone: "bad" })),
    ).toBe("INVALID_EMAIL");
    expect(
      thrownCode(() => validateSignUpInput({ ...validTeacher, password: "short", role: "admin" })),
    ).toBe("WEAK_PASSWORD");
    expect(
      thrownCode(() =>
        validateSignUpInput({ ...validTeacher, role: "admin", teacherPhone: "bad" }),
      ),
    ).toBe("INVALID_ROLE");
    // The name is checked before the phone in signUp, so it wins too.
    const { parentPhone: _omitted, ...student } = validStudent;
    expect(thrownCode(() => validateSignUpInput({ ...student, fullName: "" }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("throws INVALID_INPUT (not a crash) for a missing fullName", () => {
    const { fullName: _omitted, ...rest } = validTeacher;
    expect(thrownCode(() => validateSignUpInput(rest))).toBe("INVALID_INPUT");
  });

  it("throws INVALID_INPUT for a non-string parentPhone", () => {
    expect(thrownCode(() => validateSignUpInput({ ...validStudent, parentPhone: 123 }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("throws INVALID_INPUT for a non-object payload", () => {
    expect(thrownCode(() => validateSignUpInput(null))).toBe("INVALID_INPUT");
    expect(thrownCode(() => validateSignUpInput("not-an-object"))).toBe("INVALID_INPUT");
  });
});

describe("signInSchema", () => {
  it("parses any string email/password — sign-in has no format rules today", () => {
    expect(signInSchema.parse({ email: "teacher@example.com", password: "12345678" })).toEqual({
      email: "teacher@example.com",
      password: "12345678",
    });
    // A malformed email still parses: today it reaches the lookup and
    // fails there with INVALID_CREDENTIALS, not at the boundary.
    expect(signInSchema.parse({ email: "not-an-email", password: "x" })).toBeTruthy();
  });

  it("maps a missing/non-string field to INVALID_CREDENTIALS", () => {
    expect(thrownCode(() => validateSignInInput({ email: "a@b.com" }))).toBe("INVALID_CREDENTIALS");
    expect(thrownCode(() => validateSignInInput({ email: 123, password: "x" }))).toBe(
      "INVALID_CREDENTIALS",
    );
    expect(thrownCode(() => validateSignInInput(null))).toBe("INVALID_CREDENTIALS");
  });
});

describe("signUpSchema — fullName", () => {
  it("rejects an empty or whitespace-only name with INVALID_INPUT", () => {
    expect(thrownCode(() => validateSignUpInput({ ...validStudent, fullName: "" }))).toBe(
      "INVALID_INPUT",
    );
    expect(thrownCode(() => validateSignUpInput({ ...validStudent, fullName: "   " }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("trims a valid name", () => {
    expect(signUpSchema.parse({ ...validStudent, fullName: "  Ahmed  " }).fullName).toBe("Ahmed");
  });
});

describe("signUpSchema — optional avatar", () => {
  const jpegDataUrl = `data:image/jpeg;base64,${"QUJD".repeat(10)}`;

  it("parses a sign-up without an avatar (the common case)", () => {
    const parsed = signUpSchema.parse(validTeacher);
    expect(parsed.avatar == null).toBe(true);
  });

  it("passes a valid JPEG data URL through to the handler", () => {
    const parsed = signUpSchema.parse({ ...validTeacher, avatar: jpegDataUrl });
    expect(parsed.avatar).toBe(jpegDataUrl);
  });

  it("rejects a non-image data URL as INVALID_INPUT", () => {
    expect(
      thrownCode(() =>
        validateSignUpInput({ ...validTeacher, avatar: "data:text/html;base64,QUJD" }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("rejects an oversized data URL as INVALID_INPUT", () => {
    const huge = `data:image/jpeg;base64,${"QUJD".repeat(80_000)}`;
    expect(thrownCode(() => validateSignUpInput({ ...validTeacher, avatar: huge }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("validateSignUpInput maps a bad avatar to INVALID_INPUT, not an auth code", () => {
    expect(
      thrownCode(() => validateSignUpInput({ ...validTeacher, avatar: "not-a-data-url" })),
    ).toBe("INVALID_INPUT");
  });
});
