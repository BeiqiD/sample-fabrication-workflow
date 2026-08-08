import type { ReferenceTarget } from "../../shared/reference-types";
import type {
  CommentAttachment,
  CommentImage,
  ProcessingSampleDetail,
  RunStep,
  RunStepComment,
  SampleDetail,
} from "../../shared/types";
import type { TemplateDetail } from "./api";
import { buildRunGrid, type RunGridColumn, type RunGridRow } from "./runGrid";
import { collectSampleNotes } from "./sampleNotes";

export type ReferenceAttachmentPreview =
  | {
    kind: "image";
    id: string;
    title: string;
    assetUrl: string;
    mimeType: string;
  }
  | {
    kind: "file";
    id: string;
    title: string;
    description: string | null;
    filename: string;
    mimeType: string;
    byteSize: number;
    downloadUrl: string | null;
    status: string;
  }
  | {
    kind: "link";
    id: string;
    title: string;
    description: string | null;
    url: string;
    status: string;
  }
  | {
    kind: "execution_image";
    id: string;
    title: string;
    stepId: string;
  };

export interface ProcessingReferenceFocusMatch {
  rowIndex: number;
  columnIndex: number;
  step: RunStep;
  comment: RunStepComment | null;
  commentIndex: number | null;
  commonCommentIndex: number | null;
  preview: ReferenceAttachmentPreview | null;
}

export interface SampleReferenceFocusMatch {
  noteIndex: number;
  preview: ReferenceAttachmentPreview | null;
}

export interface MetrologyReferenceFocusMatch {
  referenceIndex: number;
}

function ready(comment: RunStepComment) {
  return (comment.status ?? "ready") === "ready";
}

function imagePreview(image: CommentImage): ReferenceAttachmentPreview | null {
  if (!image.assetKey) return null;
  return {
    kind: "image",
    id: image.id,
    title: image.originalFilename || image.filename || "Comment image",
    assetUrl: `/api/assets/${image.assetKey}`,
    mimeType: image.mimeType || image.originalMimeType || "image/*",
  };
}

function attachmentPreview(attachment: CommentAttachment): ReferenceAttachmentPreview {
  if (attachment.kind === "link") {
    return {
      kind: "link",
      id: attachment.id,
      title: attachment.title,
      description: attachment.description,
      url: attachment.url,
      status: attachment.status,
    };
  }
  return {
    kind: "file",
    id: attachment.id,
    title: attachment.title || attachment.filename,
    description: attachment.description,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    downloadUrl: attachment.downloadUrl,
    status: attachment.status,
  };
}

function commentAttachmentPreview(
  comment: RunStepComment,
  itemId: string,
): ReferenceAttachmentPreview | null {
  const image = comment.images?.find((candidate) => candidate.id === itemId);
  if (image) return imagePreview(image);
  const attachment = comment.attachments?.find((candidate) => candidate.id === itemId);
  return attachment ? attachmentPreview(attachment) : null;
}

function commentMatchesTarget(comment: RunStepComment, target: ReferenceTarget) {
  if (target.type === "comment") return comment.submissionId === target.id;
  if (target.type === "comment_occurrence") return comment.id === target.id;
  if (target.type === "comment_attachment") {
    return Boolean(
      comment.images?.some((image) => image.id === target.id)
      || comment.attachments?.some((attachment) => attachment.id === target.id),
    );
  }
  return false;
}

function commonCommentIndex(row: RunGridRow, targetComment: RunStepComment) {
  const keys: string[] = [];
  for (const step of row.steps) {
    if (!step) continue;
    for (const comment of step.comments) {
      if (comment.scope !== "common" || !ready(comment)) continue;
      const key = comment.operationGroupId || comment.id;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const targetKey = targetComment.operationGroupId || targetComment.id;
  const index = keys.indexOf(targetKey);
  return index >= 0 ? index : null;
}

function individualCommentIndex(step: RunStep, targetComment: RunStepComment) {
  const comments = step.comments.filter((comment) => comment.scope === "individual" && ready(comment));
  const index = comments.indexOf(targetComment);
  return index >= 0 ? index : null;
}

export function findProcessingReferenceFocus(
  columns: RunGridColumn[],
  sampleId: string,
  stepId: string,
  focus: ReferenceTarget,
): ProcessingReferenceFocusMatch | null {
  if (![
    "run_step",
    "comment",
    "comment_occurrence",
    "comment_attachment",
    "execution_image",
  ].includes(focus.type)) return null;

  const expectedStepId = focus.type === "run_step" ? focus.id : stepId;
  if (!expectedStepId) return null;
  const rows = buildRunGrid(columns);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      if (columns[columnIndex]?.sample.id !== sampleId) continue;
      const step = row.steps[columnIndex];
      if (!step || step.id !== expectedStepId) continue;

      if (focus.type === "run_step") {
        return {
          rowIndex,
          columnIndex,
          step,
          comment: null,
          commentIndex: null,
          commonCommentIndex: null,
          preview: null,
        };
      }

      if (focus.type === "execution_image") {
        return {
          rowIndex,
          columnIndex,
          step,
          comment: null,
          commentIndex: null,
          commonCommentIndex: null,
          preview: {
            kind: "execution_image",
            id: focus.id,
            title: `Execution image for ${step.title}`,
            stepId: step.id,
          },
        };
      }

      const comment = step.comments.find((candidate) => (
        ready(candidate) && commentMatchesTarget(candidate, focus)
      )) ?? null;
      if (!comment) return null;
      const common = comment.scope === "common";
      return {
        rowIndex,
        columnIndex,
        step,
        comment,
        commentIndex: common ? null : individualCommentIndex(step, comment),
        commonCommentIndex: common ? commonCommentIndex(row, comment) : null,
        preview: focus.type === "comment_attachment"
          ? commentAttachmentPreview(comment, focus.id)
          : null,
      };
    }
  }
  return null;
}

export function processingFocusColumns(
  primarySample: ProcessingSampleDetail,
  selectedRunId: string,
  additionalSamples: ProcessingSampleDetail[] = [],
): RunGridColumn[] {
  const selectedRun = primarySample.runs.find((run) => run.id === selectedRunId) ?? null;
  return [
    { sample: primarySample, run: selectedRun },
    ...additionalSamples.map((sample) => ({
      sample,
      run: selectedRun
        ? sample.runs.find((run) => (
          run.runKind === selectedRun.runKind
          && run.recipeFamilyId === selectedRun.recipeFamilyId
          && run.status === selectedRun.status
        )) ?? null
        : null,
    })),
  ];
}

export function findSampleReferenceFocus(
  sample: SampleDetail,
  focus: ReferenceTarget,
): SampleReferenceFocusMatch | null {
  if (focus.type !== "comment" && focus.type !== "comment_attachment") return null;
  const comments = (sample.comments ?? []).filter((comment) => comment.status === "ready");
  const comment = focus.type === "comment"
    ? comments.find((candidate) => candidate.id === focus.id)
    : comments.find((candidate) => (
      candidate.images.some((image) => image.id === focus.id)
      || candidate.attachments.some((attachment) => attachment.id === focus.id)
    ));
  if (!comment) return null;

  const notes = collectSampleNotes(sample);
  const noteIndex = notes.findIndex((note) => note.submissionId === comment.id);
  if (noteIndex < 0) return null;

  let preview: ReferenceAttachmentPreview | null = null;
  if (focus.type === "comment_attachment") {
    const image = comment.images.find((candidate) => candidate.id === focus.id);
    if (image) preview = imagePreview(image);
    else {
      const attachment = comment.attachments.find((candidate) => candidate.id === focus.id);
      preview = attachment ? attachmentPreview(attachment) : null;
    }
  }
  return { noteIndex, preview };
}

export function findMetrologyReferenceFocus(
  template: TemplateDetail,
  focus: ReferenceTarget,
): MetrologyReferenceFocusMatch | null {
  if (focus.type !== "metrology_reference") return null;
  const referenceIndex = template.referenceAttachments.findIndex((reference) => reference.id === focus.id);
  return referenceIndex >= 0 ? { referenceIndex } : null;
}
