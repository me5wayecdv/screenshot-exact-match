import { describe, expect, it } from "vitest";
import { uploadKind } from "@/lib/uploads";

describe("uploadKind", () => {
  it("passes images through", () => {
    expect(uploadKind({ type: "image/jpeg", name: "paper.jpg" })).toBe("image");
    expect(uploadKind({ type: "image/png", name: "scan" })).toBe("image");
  });
  it("detects PDF by MIME or extension", () => {
    expect(uploadKind({ type: "application/pdf", name: "a.bin" })).toBe("pdf");
    expect(uploadKind({ type: "", name: "answers.PDF" })).toBe("pdf");
  });
  it("detects DOCX by MIME or extension", () => {
    expect(
      uploadKind({
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        name: "a.bin",
      }),
    ).toBe("docx");
    expect(uploadKind({ type: "", name: "answers.DOCX" })).toBe("docx");
  });
  it("rejects legacy .doc and other formats", () => {
    expect(uploadKind({ type: "application/msword", name: "old.doc" })).toBe("unsupported");
    expect(uploadKind({ type: "text/plain", name: "notes.txt" })).toBe("unsupported");
    expect(uploadKind({ type: "", name: "archive.zip" })).toBe("unsupported");
  });
});
