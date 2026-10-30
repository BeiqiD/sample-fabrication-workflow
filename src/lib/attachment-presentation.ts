/** Human-readable metadata only; these helpers do not decide upload or read availability. */
export function formatAttachmentBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  if (bytes === 0) return "0 B";
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1000 ** 2) return `${(bytes / 1000).toFixed(1)} kB`;
  if (bytes < 1000 ** 3) return `${(bytes / 1000 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1000 ** 3).toFixed(1)} GB`;
}

const readableStatuses = new Map<string, string>([
  ["draft", "Draft"],
  ["pending", "Pending upload"],
  ["waiting", "Waiting to upload"],
  ["hashing", "Checking file hash"],
  ["uploading", "Uploading"],
  ["ready", "Ready"],
  ["failed", "Upload incomplete"],
  ["cancelled", "Cancelled"],
  ["removed", "Removed"],
  ["unavailable", "Unavailable"],
  ["uncertain", "Outcome uncertain"],
]);

export function attachmentStatusLabel(value: string | null | undefined): string {
  return value ? readableStatuses.get(value) ?? "Status unknown" : "Status unavailable";
}

/** Keep a caller's authorized URL intact; never construct or resolve a file locator. */
export function safeAttachmentHref(value: string | null | undefined): string | null {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || value.includes("\\") || value.startsWith("//")) return null;
  try {
    const parsed = new URL(value, "https://attachment-presentation.invalid/");
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}
