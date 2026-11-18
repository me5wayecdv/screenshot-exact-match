// One-shot handoff from the assessments index page to the AI generate page:
// the index's AI card collects a PDF and/or pasted lesson text, and the
// generate page consumes them on mount and runs its existing pipeline. It
// lives at module level (not router state) because a File payload cannot
// cross a route navigation's serializable search params.
export type GenerateHandoff = {
  file?: { name: string; dataUrl: string };
  text?: string;
};

let handoff: GenerateHandoff | null = null;

export function setGenerateHandoff(next: GenerateHandoff): void {
  handoff = next;
}

export function takeGenerateHandoff(): GenerateHandoff | null {
  const current = handoff;
  handoff = null;
  return current;
}

export function dataUrlToFile(name: string, dataUrl: string): File {
  const [head, b64] = dataUrl.split(",");
  const mime = /data:(.*?);/.exec(head ?? "")?.[1] ?? "application/octet-stream";
  const bin = atob(b64 ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}
