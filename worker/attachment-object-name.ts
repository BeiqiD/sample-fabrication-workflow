/** The original shared attachment object-name algorithm; no provider authority. */
export function safeAttachmentObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
}
