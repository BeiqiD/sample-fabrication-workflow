import type {
  CreateMarkdownProjectItemInput,
  CreateProjectEdgeInput,
  CreateReferenceProjectItemInput,
  ProjectSnapshot,
} from "../../shared/project-api";
import type { CopyAttachmentProjectItemInput } from "../../shared/project-copy-paste-api";
import {
  isProjectApiId,
  isProjectExpectedRevision,
} from "../../shared/project-api";
import type { ReferenceTarget } from "../../shared/reference-types";
import type { ProjectMapGeometry } from "../../shared/project-types";
import {
  isProjectMapGeometry,
  MAX_PROJECT_MAP_COORDINATE_ABS,
  MAX_PROJECT_MAP_Z_INDEX_ABS,
} from "../../shared/project-types";

export const PROJECT_CANVAS_PASTE_OFFSET = 32;

interface ProjectCanvasClipboardItemBase {
  sourceItemId: string;
  geometry: ProjectMapGeometry;
}

export type ProjectCanvasClipboardItem =
  | (ProjectCanvasClipboardItemBase & {
    kind: "reference";
    target: ReferenceTarget;
  })
  | (ProjectCanvasClipboardItemBase & {
    kind: "markdown";
    sourceContentId: string;
    markdownSource: string;
  })
  | (ProjectCanvasClipboardItemBase & {
    kind: "attachment";
    sourceContentId: string;
    caption: string | null;
    sourceUrl: string | null;
  });

export interface ProjectCanvasClipboardEdge {
  sourceEdgeId: string;
  sourceItemId: string;
  targetItemId: string;
  sourceHandle: CreateProjectEdgeInput["sourceHandle"];
  targetHandle: CreateProjectEdgeInput["targetHandle"];
  markerStart: CreateProjectEdgeInput["markerStart"];
  markerEnd: CreateProjectEdgeInput["markerEnd"];
  label: string | null;
}

export interface ProjectCanvasClipboard {
  version: 1;
  sourceProjectId: string;
  items: ProjectCanvasClipboardItem[];
  edges: ProjectCanvasClipboardEdge[];
}

export type ProjectCanvasPasteStepStatus = "pending" | "acknowledged";

export type ProjectCanvasPasteItemStep =
  | {
    kind: "reference";
    sourceItemId: string;
    destinationItemId: string;
    status: ProjectCanvasPasteStepStatus;
    input: CreateReferenceProjectItemInput;
  }
  | {
    kind: "markdown";
    sourceItemId: string;
    destinationItemId: string;
    status: ProjectCanvasPasteStepStatus;
    input: CreateMarkdownProjectItemInput;
  }
  | {
    kind: "attachment";
    sourceItemId: string;
    destinationItemId: string;
    status: ProjectCanvasPasteStepStatus;
    input: CopyAttachmentProjectItemInput;
  };

export interface ProjectCanvasPasteEdgeStep {
  sourceEdgeId: string;
  destinationEdgeId: string;
  status: ProjectCanvasPasteStepStatus;
  input: CreateProjectEdgeInput;
}

export interface ProjectCanvasPasteJournal {
  version: 1;
  journalId: string;
  projectId: string;
  baseProjectRevision: number;
  pasteOrdinal: number;
  itemSteps: ProjectCanvasPasteItemStep[];
  edgeSteps: ProjectCanvasPasteEdgeStep[];
}

export type ProjectCanvasPasteIdentityKind =
  | "journal"
  | "item"
  | "content"
  | "placement"
  | "edge"
  | "operation";

export type ProjectCanvasPasteIdentityFactory = (
  kind: ProjectCanvasPasteIdentityKind,
  sourceId: string,
  ordinal: number,
) => string;

export interface CreateProjectCanvasPasteJournalOptions {
  pasteOrdinal?: number;
  createIdentity?: ProjectCanvasPasteIdentityFactory;
}

export interface ProjectCanvasPasteClients {
  createReferenceItem: (
    projectId: string,
    input: CreateReferenceProjectItemInput,
  ) => Promise<unknown>;
  createMarkdownItem: (
    projectId: string,
    input: CreateMarkdownProjectItemInput,
  ) => Promise<unknown>;
  copyAttachmentItem: (
    projectId: string,
    input: CopyAttachmentProjectItemInput,
  ) => Promise<unknown>;
  createEdge: (
    projectId: string,
    input: CreateProjectEdgeInput,
  ) => Promise<unknown>;
}

export interface ProjectCanvasPasteFailure {
  kind: "item" | "edge";
  sourceId: string;
  destinationId: string;
}

export type ProjectCanvasPasteExecutionResult =
  | {
    status: "complete";
    journal: ProjectCanvasPasteJournal;
  }
  | {
    status: "paused";
    journal: ProjectCanvasPasteJournal;
    failedStep: ProjectCanvasPasteFailure;
    error: unknown;
  };

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function compareSourceItems(
  left: ProjectSnapshot["items"][number],
  right: ProjectSnapshot["items"][number],
) {
  return left.createdSequence - right.createdSequence || left.id.localeCompare(right.id);
}

export function buildProjectCanvasClipboard(
  snapshot: ProjectSnapshot,
  selectedItemIds: readonly string[],
): ProjectCanvasClipboard | null {
  const requestedIds = [...new Set(selectedItemIds.filter(Boolean))];
  if (requestedIds.length === 0) return null;

  const itemsById = new Map(snapshot.items.map((item) => [item.id, item]));
  const requestedItems = requestedIds.map((itemId) => {
    const item = itemsById.get(itemId);
    if (!item || item.deletedAt !== null) {
      throw new Error(`Selected Project item ${itemId} is not available for copy`);
    }
    return item;
  }).sort(compareSourceItems);
  const selected = new Set(requestedItems.map((item) => item.id));
  const placementByItem = new Map(snapshot.placements.map((placement) => [
    placement.projectItemId,
    placement,
  ]));
  const contentById = new Map(snapshot.contents.map((content) => [content.id, content]));
  const attachmentByContent = new Map(snapshot.attachments.map((attachment) => [
    attachment.projectContentId,
    attachment,
  ]));
  const referenceByRegistryId = new Map(snapshot.references.map((reference) => [
    reference.registryId,
    reference,
  ]));

  const items: ProjectCanvasClipboardItem[] = requestedItems.map((item) => {
    const placement = requireValue(
      placementByItem.get(item.id),
      `Project item ${item.id} has no authoritative placement`,
    );
    const geometry: ProjectMapGeometry = {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      zIndex: placement.zIndex,
    };

    if (item.itemType === "reference") {
      const registryId = requireValue(
        item.referenceTargetId,
        `Reference item ${item.id} has no target identity`,
      );
      const reference = requireValue(
        referenceByRegistryId.get(registryId),
        `Reference item ${item.id} has no authoritative resolution`,
      );
      return {
        kind: "reference",
        sourceItemId: item.id,
        target: { ...reference.resolution.target },
        geometry,
      };
    }

    const contentId = requireValue(
      item.projectContentId,
      `Content item ${item.id} has no content identity`,
    );
    const content = requireValue(
      contentById.get(contentId),
      `Project content ${contentId} is not available for copy`,
    );
    if (content.deletedAt !== null) {
      throw new Error(`Project content ${contentId} is not available for copy`);
    }
    if (content.contentType === "markdown") {
      return {
        kind: "markdown",
        sourceItemId: item.id,
        sourceContentId: content.id,
        markdownSource: requireValue(
          content.markdownSource,
          `Project Markdown ${content.id} has no source payload`,
        ),
        geometry,
      };
    }

    requireValue(
      attachmentByContent.get(content.id),
      `Project attachment ${content.id} has no authoritative blob binding`,
    );
    return {
      kind: "attachment",
      sourceItemId: item.id,
      sourceContentId: content.id,
      caption: content.attachmentCaption,
      sourceUrl: content.attachmentSourceUrl,
      geometry,
    };
  });

  const edges = snapshot.edges
    .filter((edge) => edge.deletedAt === null
      && selected.has(edge.sourceItemId)
      && selected.has(edge.targetItemId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id))
    .map<ProjectCanvasClipboardEdge>((edge) => ({
      sourceEdgeId: edge.id,
      sourceItemId: edge.sourceItemId,
      targetItemId: edge.targetItemId,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      markerStart: edge.markerStart,
      markerEnd: edge.markerEnd,
      label: edge.label,
    }));

  return {
    version: 1,
    sourceProjectId: snapshot.project.id,
    items,
    edges,
  };
}

function defaultIdentity(kind: ProjectCanvasPasteIdentityKind) {
  return `${kind}-${crypto.randomUUID()}`;
}

function clampedTranslation(
  desired: number,
  values: readonly number[],
  limit: number,
) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return Math.max(-limit - minimum, Math.min(desired, limit - maximum));
}

function translatedGeometry(
  geometry: ProjectMapGeometry,
  deltaX: number,
  deltaY: number,
  deltaZ: number,
) {
  const translated = {
    ...geometry,
    x: geometry.x + deltaX,
    y: geometry.y + deltaY,
    zIndex: geometry.zIndex + deltaZ,
  };
  if (!isProjectMapGeometry(translated)) {
    throw new Error("Pasted Project geometry exceeds the authoritative Map bounds");
  }
  return translated;
}

export function createProjectCanvasPasteJournal(
  snapshot: ProjectSnapshot,
  clipboard: ProjectCanvasClipboard,
  options: CreateProjectCanvasPasteJournalOptions = {},
): ProjectCanvasPasteJournal {
  if (clipboard.sourceProjectId !== snapshot.project.id) {
    throw new Error("Phase 4B2 copy/paste is limited to one authoritative Project");
  }
  if (clipboard.items.length === 0) {
    throw new Error("The Project clipboard has no items to paste");
  }

  const pasteOrdinal = options.pasteOrdinal ?? 1;
  if (!Number.isSafeInteger(pasteOrdinal) || pasteOrdinal < 1) {
    throw new Error("Paste ordinal must be a positive safe integer");
  }
  const desiredOffset = PROJECT_CANVAS_PASTE_OFFSET * pasteOrdinal;
  if (!Number.isSafeInteger(desiredOffset)) {
    throw new Error("Paste offset exceeds the safe integer range");
  }

  const sourceX = clipboard.items.map((item) => item.geometry.x);
  const sourceY = clipboard.items.map((item) => item.geometry.y);
  const sourceZ = clipboard.items.map((item) => item.geometry.zIndex);
  const deltaX = clampedTranslation(
    desiredOffset,
    sourceX,
    MAX_PROJECT_MAP_COORDINATE_ABS,
  );
  const deltaY = clampedTranslation(
    desiredOffset,
    sourceY,
    MAX_PROJECT_MAP_COORDINATE_ABS,
  );
  const highestExistingZ = snapshot.placements.reduce(
    (highest, placement) => Math.max(highest, placement.zIndex),
    -MAX_PROJECT_MAP_Z_INDEX_ABS,
  );
  const minimumSourceZ = Math.min(...sourceZ);
  const maximumSourceZ = Math.max(...sourceZ);
  const desiredZDelta = highestExistingZ + 1 - minimumSourceZ;
  const deltaZ = Math.max(
    -MAX_PROJECT_MAP_Z_INDEX_ABS - minimumSourceZ,
    Math.min(
      desiredZDelta,
      MAX_PROJECT_MAP_Z_INDEX_ABS - maximumSourceZ,
    ),
  );

  const createIdentity = options.createIdentity ?? defaultIdentity;
  const allocated = new Set<string>([
    snapshot.project.id,
    ...snapshot.contents.map((content) => content.id),
    ...snapshot.items.map((item) => item.id),
    ...snapshot.placements.map((placement) => placement.id),
    ...snapshot.edges.map((edge) => edge.id),
  ]);
  let allocationOrdinal = 0;
  const allocate = (
    kind: ProjectCanvasPasteIdentityKind,
    sourceId: string,
  ) => {
    const identity = createIdentity(kind, sourceId, allocationOrdinal++);
    if (!isProjectApiId(identity)) {
      throw new Error(`Generated ${kind} identity is not a valid Project API ID`);
    }
    if (allocated.has(identity)) {
      throw new Error(`Generated ${kind} identity is not fresh`);
    }
    allocated.add(identity);
    return identity;
  };

  const journalId = allocate("journal", snapshot.project.id);
  const destinationItemBySource = new Map<string, string>();
  const itemSteps = clipboard.items.map<ProjectCanvasPasteItemStep>((item, index) => {
    const expectedProjectRevision = snapshot.project.revision + index;
    if (!isProjectExpectedRevision(expectedProjectRevision)) {
      throw new Error("Paste would exceed the Project revision range");
    }
    const destinationItemId = allocate("item", item.sourceItemId);
    const placementId = allocate("placement", item.sourceItemId);
    const operationId = allocate("operation", item.sourceItemId);
    const geometry = translatedGeometry(item.geometry, deltaX, deltaY, deltaZ);
    destinationItemBySource.set(item.sourceItemId, destinationItemId);

    if (item.kind === "reference") {
      return {
        kind: "reference",
        sourceItemId: item.sourceItemId,
        destinationItemId,
        status: "pending",
        input: {
          itemId: destinationItemId,
          placementId,
          target: { ...item.target },
          geometry,
          expectedProjectRevision,
          operationId,
        },
      };
    }

    const contentId = allocate("content", item.sourceContentId);
    if (item.kind === "markdown") {
      return {
        kind: "markdown",
        sourceItemId: item.sourceItemId,
        destinationItemId,
        status: "pending",
        input: {
          contentId,
          itemId: destinationItemId,
          placementId,
          markdownSource: item.markdownSource,
          geometry,
          expectedProjectRevision,
          operationId,
        },
      };
    }

    return {
      kind: "attachment",
      sourceItemId: item.sourceItemId,
      destinationItemId,
      status: "pending",
      input: {
        sourceContentId: item.sourceContentId,
        contentId,
        itemId: destinationItemId,
        placementId,
        caption: item.caption,
        sourceUrl: item.sourceUrl,
        geometry,
        expectedProjectRevision,
        operationId,
      },
    };
  });

  const edgeSteps = clipboard.edges.map<ProjectCanvasPasteEdgeStep>((edge) => {
    const sourceItemId = requireValue(
      destinationItemBySource.get(edge.sourceItemId),
      `Copied edge ${edge.sourceEdgeId} has no copied source endpoint`,
    );
    const targetItemId = requireValue(
      destinationItemBySource.get(edge.targetItemId),
      `Copied edge ${edge.sourceEdgeId} has no copied target endpoint`,
    );
    const destinationEdgeId = allocate("edge", edge.sourceEdgeId);
    return {
      sourceEdgeId: edge.sourceEdgeId,
      destinationEdgeId,
      status: "pending",
      input: {
        edgeId: destinationEdgeId,
        sourceItemId,
        targetItemId,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        markerStart: edge.markerStart,
        markerEnd: edge.markerEnd,
        label: edge.label,
        expectedSourceItemRevision: 1,
        expectedTargetItemRevision: 1,
        operationId: allocate("operation", edge.sourceEdgeId),
      },
    };
  });

  return {
    version: 1,
    journalId,
    projectId: snapshot.project.id,
    baseProjectRevision: snapshot.project.revision,
    pasteOrdinal,
    itemSteps,
    edgeSteps,
  };
}

function acknowledgeItemStep(
  journal: ProjectCanvasPasteJournal,
  index: number,
): ProjectCanvasPasteJournal {
  return {
    ...journal,
    itemSteps: journal.itemSteps.map((step, candidateIndex) => (
      candidateIndex === index ? { ...step, status: "acknowledged" } : step
    )),
  };
}

function acknowledgeEdgeStep(
  journal: ProjectCanvasPasteJournal,
  index: number,
): ProjectCanvasPasteJournal {
  return {
    ...journal,
    edgeSteps: journal.edgeSteps.map((step, candidateIndex) => (
      candidateIndex === index ? { ...step, status: "acknowledged" } : step
    )),
  };
}

export async function executeProjectCanvasPasteJournal(
  journal: ProjectCanvasPasteJournal,
  clients: ProjectCanvasPasteClients,
): Promise<ProjectCanvasPasteExecutionResult> {
  let current = journal;
  for (let index = 0; index < current.itemSteps.length; index += 1) {
    const step = current.itemSteps[index];
    if (step.status === "acknowledged") continue;
    try {
      if (step.kind === "reference") {
        await clients.createReferenceItem(current.projectId, step.input);
      } else if (step.kind === "markdown") {
        await clients.createMarkdownItem(current.projectId, step.input);
      } else {
        await clients.copyAttachmentItem(current.projectId, step.input);
      }
    } catch (error) {
      return {
        status: "paused",
        journal: current,
        failedStep: {
          kind: "item",
          sourceId: step.sourceItemId,
          destinationId: step.destinationItemId,
        },
        error,
      };
    }
    current = acknowledgeItemStep(current, index);
  }

  for (let index = 0; index < current.edgeSteps.length; index += 1) {
    const step = current.edgeSteps[index];
    if (step.status === "acknowledged") continue;
    try {
      await clients.createEdge(current.projectId, step.input);
    } catch (error) {
      return {
        status: "paused",
        journal: current,
        failedStep: {
          kind: "edge",
          sourceId: step.sourceEdgeId,
          destinationId: step.destinationEdgeId,
        },
        error,
      };
    }
    current = acknowledgeEdgeStep(current, index);
  }

  return { status: "complete", journal: current };
}

export function projectCanvasPasteDestinationItemIds(
  journal: ProjectCanvasPasteJournal,
) {
  return journal.itemSteps.map((step) => step.destinationItemId);
}

export function projectCanvasPasteHasAcknowledgedWrites(
  journal: ProjectCanvasPasteJournal,
) {
  return journal.itemSteps.some((step) => step.status === "acknowledged")
    || journal.edgeSteps.some((step) => step.status === "acknowledged");
}
