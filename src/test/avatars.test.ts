/**
 * Avatar storage helpers (src/server/d1-avatars.ts): the key always
 * follows the enforced {owner}/{uuid}/{name} R2 shape, and data-URL
 * decoding is defensive even though the zod schema validates first.
 */
import { describe, expect, it } from "vitest";
import { avatarBytesFromDataUrl, avatarKeyFor } from "@/server/d1-avatars";

describe("avatarKeyFor", () => {
  it("builds the deterministic per-user key", () => {
    expect(avatarKeyFor("user-123")).toBe(
      "user-123/00000000-0000-0000-0000-000000000000/avatar.jpg",
    );
  });

  it("rejects a user id that would break the key shape", () => {
    expect(() => avatarKeyFor("../admin")).toThrow();
    expect(() => avatarKeyFor("")).toThrow();
  });
});

describe("avatarBytesFromDataUrl", () => {
  it("decodes a valid jpeg data URL", () => {
    const bytes = avatarBytesFromDataUrl(`data:image/jpeg;base64,${btoa("hello-bytes")}`);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("hello-bytes");
  });

  it("rejects malformed or oversized input", () => {
    expect(avatarBytesFromDataUrl("data:text/html;base64,QUJD")).toBeNull();
    expect(avatarBytesFromDataUrl("not-a-data-url")).toBeNull();
    expect(avatarBytesFromDataUrl(`data:image/jpeg;base64,${"QUJD".repeat(80_000)}`)).toBeNull();
    expect(avatarBytesFromDataUrl("data:image/jpeg;base64,%%%")).toBeNull();
  });
});
