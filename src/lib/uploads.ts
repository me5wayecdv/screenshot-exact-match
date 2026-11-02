/** Classify an upload for the handwritten conversion pipeline.
 * image passes through as-is; pdf renders via pdfjs; docx extracts via
 * mammoth; anything else (including legacy .doc) is unsupported. */
export function uploadKind(file: {
  type: string;
  name: string;
}): "image" | "pdf" | "docx" | "unsupported" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(file.name)
  )
    return "docx";
  return "unsupported";
}
