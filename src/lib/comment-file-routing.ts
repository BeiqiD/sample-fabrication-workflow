import { isTiffMetadata } from "../../shared/tiff";

type CommentFileMetadata = Pick<File, "name" | "type">;

export function isCommentImageFile(file: CommentFileMetadata) {
  return file.type.startsWith("image/") || isTiffMetadata(file.name, file.type);
}

export function partitionCommentFiles<T extends CommentFileMetadata>(files: T[]) {
  const images: T[] = [];
  const attachments: T[] = [];
  for (const file of files) {
    (isCommentImageFile(file) ? images : attachments).push(file);
  }
  return { images, attachments };
}

function commentComposer(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLFormElement>(".grid-comment-composer")
    : null;
}

function dispatchFiles(input: HTMLInputElement | null, files: File[]) {
  if (!files.length) return true;
  if (!input) return false;
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  const wasDisabled = input.disabled;
  if (wasDisabled) input.disabled = false;
  try {
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } finally {
    if (wasDisabled) input.disabled = true;
  }
  return true;
}

function routeFiles(composer: HTMLFormElement, files: File[]) {
  const { images, attachments } = partitionCommentFiles(files);
  const imageInput = composer.querySelector<HTMLInputElement>('input.comment-file-input[accept]');
  const attachmentInput = composer.querySelector<HTMLInputElement>('input.comment-file-input:not([accept])');
  return dispatchFiles(imageInput, images) && dispatchFiles(attachmentInput, attachments);
}

let installed = false;

export function installCommentFileRouting() {
  if (installed || typeof document === "undefined") return;
  installed = true;

  document.addEventListener("drop", (event) => {
    const composer = commentComposer(event.target);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!composer || !files.length || !routeFiles(composer, files)) return;
    event.preventDefault();
    event.stopPropagation();
    composer.dispatchEvent(new Event("dragleave", { bubbles: true }));
  }, true);

  document.addEventListener("paste", (event) => {
    const composer = commentComposer(event.target);
    const files = [...(event.clipboardData?.files ?? [])];
    if (!composer || !files.length || !routeFiles(composer, files)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}
