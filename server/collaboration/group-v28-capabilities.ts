/** This describes the explicitly selected runtime surface, never a principal's
 * permission or an admission receipt. Each operation still performs its own
 * genuine Request/session/member/root checks inside the current native BEGIN. */
export interface GroupV28Capabilities {
  readonly kind: "explicit-v28-development-capabilities/1";
  readonly routes: readonly Readonly<{ method: string; path: string }>[];
  readonly content: "metadata-and-text" | "metadata-text-and-canonical-comment-attachment-bytes" | "metadata-text-and-canonical-sample-attachment-descriptors";
  readonly authorities: readonly string[];
  readonly unavailable: readonly string[];
}
export function groupV28Capabilities(routes: GroupV28Capabilities["routes"], sampleMetadataReads = false, canonicalComments = false, canonicalSampleAttachments = false): Readonly<GroupV28Capabilities> {
  const fabublox=routes.some(route=>route.method==="POST" && route.path==="/api/imports/fabublox");
  const activeTemplateMetadata=fabublox && routes.some(route=>route.method==="GET" && route.path==="/api/templates/:id");
  return Object.freeze({ kind: "explicit-v28-development-capabilities/1" as const,
    routes: Object.freeze(routes.map(route => Object.freeze({ ...route }))), content: canonicalSampleAttachments ? "metadata-text-and-canonical-sample-attachment-descriptors" as const : canonicalComments ? "metadata-text-and-canonical-comment-attachment-bytes" as const : "metadata-and-text" as const,
    authorities: Object.freeze([
      "current-local-session", "active-explicit-membership", "named-sample-root", "named-project-root",
      "named-live-template-family", "all-comment-target-roots", "all-reference-source-roots",
      "separate-membership-administrator", "separate-root-manager", "explicit-stopped-enrollment-and-activation",
      ...(canonicalComments ? ["request-and-purpose-bound-canonical-comment-acceptance-and-attachment-read"] : []),
      ...(fabublox?["request-and-purpose-bound-fabublox-acceptance", "active-file-aware-process-preview-and-run-start", "active-file-original-empty-sample-creation"]:[]),
      ...(activeTemplateMetadata ? ["active-file-native-template-metadata-and-locked-read-without-byte-grants"] : []),
      ...(canonicalSampleAttachments ? ["actual-opaque-original-sample-attachment-probe", "same-native-final-sample-and-file-authority"] : []),
    ]),
    unavailable: Object.freeze([
      canonicalComments ? "file-bytes-outside-canonical-comment-attachments" : "file-bytes-and-file-grants", fabublox ? canonicalComments ? "uploads-outside-explicit-fabublox-and-canonical-comment-acceptance" : "uploads-outside-explicit-fabublox-acceptance" : canonicalComments ? "uploads-outside-canonical-comment-acceptance-and-image-processing" : "uploads-and-image-processing", "jobs-and-package-import-export",
      ...(canonicalSampleAttachments ? ["sample-attachment-descriptors-above-supported-collection-bound"] : []),
      ...(canonicalComments ? [canonicalSampleAttachments ? "canonical-comment-image-and-other-sample-media-descriptors" : "canonical-comment-image-bytes-and-sample-media-descriptors", "legacy-fenced-domain-operations-while-file-authority-active"] : []),
      "system-backup-and-assisted-recovery", sampleMetadataReads ? canonicalSampleAttachments ? "sample-processing-media-and-other-file-descriptors" : "sample-processing-media-and-file-descriptors" : "sample-detail-and-processing-media", "sample-split-with-processing-media",
      "project-attachments-and-file-lifecycle", "provider-egress", "frontend-static-serving",
    ]),
  });
}
