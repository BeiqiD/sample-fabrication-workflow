import { isResearchRecordKind, RESEARCH_EVENT_RELATIONSHIP_FIELDS, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";

export type ImportIdentityKind = ResearchRecordKind | "operation" | "group";
export interface ImportDomainIdentity { kind: ImportIdentityKind; sourceId: string; destinationId: string }
export class ImportDomainError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "ImportDomainError"; }
}

function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))
    throw new ImportDomainError("invalid_domain_identity");
}
const key = (kind: ImportIdentityKind, sourceId: string) => JSON.stringify([kind, sourceId]);

/** A typed map, never a search/replace across text or content hashes. Allocate
 * records before following relationships, so cyclic graphs retain one identity. */
export class ImportIdentityMap {
  private readonly values = new Map<string, ImportDomainIdentity>();
  private readonly allocated = new Set<string>();
  constructor(private readonly randomId: () => string, private readonly sourceIds: ReadonlySet<string>) {}

  register(kind: ImportIdentityKind, sourceId: string, destinationId?: string): string {
    identity(sourceId);
    if (!isResearchRecordKind(kind) && kind !== "operation" && kind !== "group") throw new ImportDomainError("unknown_domain_kind");
    const existing = this.values.get(key(kind, sourceId));
    if (existing) {
      if (destinationId !== undefined && existing.destinationId !== destinationId) throw new ImportDomainError("conflicting_identity_map");
      return existing.destinationId;
    }
    const generated = destinationId === undefined;
    const id = destinationId ?? this.randomId();
    identity(id);
    if (id.length > 256 || generated && (this.sourceIds.has(id) || this.allocated.has(id)))
      throw new ImportDomainError("destination_identity_collision");
    this.allocated.add(id);
    this.values.set(key(kind, sourceId), { kind, sourceId, destinationId: id });
    return id;
  }

  get(kind: ImportIdentityKind, sourceId: unknown): string {
    identity(sourceId);
    const value = this.values.get(key(kind, sourceId));
    if (!value) throw new ImportDomainError("missing_domain_dependency");
    return value.destinationId;
  }
  has(kind: ImportIdentityKind, sourceId: string): boolean { return this.values.has(key(kind, sourceId)); }
  entries(): ImportDomainIdentity[] {
    return [...this.values.values()].sort((a, b) => key(a.kind, a.sourceId).localeCompare(key(b.kind, b.sourceId)));
  }
}

export const REFERENCE_IMPORT_KINDS = {
  sample: "sample", run: "run", run_step: "runStep", comment: "comment", comment_occurrence: "commentOccurrence",
  comment_attachment: "commentItem", execution_image: "executionImage", metrology_reference: "metrologyReference",
  recipe_revision: "recipeRevision",
} as const satisfies Record<string, ResearchRecordKind>;

export function referenceImportKind(value: unknown): ResearchRecordKind {
  if (typeof value !== "string" || !Object.hasOwn(REFERENCE_IMPORT_KINDS, value)) throw new ImportDomainError("unknown_reference_kind");
  return REFERENCE_IMPORT_KINDS[value as keyof typeof REFERENCE_IMPORT_KINDS];
}

export interface ImportEventRelationship {
  field: string;
  target: { kind: ImportIdentityKind; sourceId: string };
  resolution: "included" | "unresolved" | "deleted" | "excluded";
}

/** Only catalogued top-level event pointers are executable relationships. The
 * remaining metadata is user/history text and is copied without substitution. */
export function rewriteImportEventRelationships(metadata: Record<string, unknown>, relationships: readonly ImportEventRelationship[],
  identities: ImportIdentityMap): Record<string, unknown> {
  const result: Record<string, unknown> = { ...metadata };
  const used = new Set<string>();
  const arrays = new Map<string, Map<number, string>>();
  for (const relationship of relationships) {
    const match = /^([A-Za-z][A-Za-z0-9]*)(?:\[(0|[1-9][0-9]*)\])?$/.exec(relationship.field);
    const root = match?.[1];
    const rule = root && Object.hasOwn(RESEARCH_EVENT_RELATIONSHIP_FIELDS, root)
      ? RESEARCH_EVENT_RELATIONSHIP_FIELDS[root as keyof typeof RESEARCH_EVENT_RELATIONSHIP_FIELDS] : null;
    if (!rule || used.has(relationship.field) || rule.kind !== relationship.target.kind
      || rule.array !== (match?.[2] !== undefined)) throw new ImportDomainError("invalid_event_relationship");
    used.add(relationship.field);
    const kind = rule.kind;
    if ((kind === "operation" || kind === "group") || relationship.resolution !== "included" && !identities.has(kind, relationship.target.sourceId))
      identities.register(kind, relationship.target.sourceId);
    const destination = identities.get(kind, relationship.target.sourceId);
    if (rule.array) {
      const index = Number(match![2]);
      if (!Number.isSafeInteger(index) || index > 1200) throw new ImportDomainError("invalid_event_relationship");
      let array = arrays.get(root!); if (!array) arrays.set(root!, array = new Map());
      array.set(index, destination);
    } else result[root!] = destination;
  }
  for (const [root, array] of arrays) {
    if ([...array.keys()].some(index => index >= array.size)) throw new ImportDomainError("invalid_event_relationship");
    result[root] = Array.from({ length: array.size }, (_, index) => array.get(index)!);
  }
  return result;
}

/** Last-known reference context is typed provenance. Fresh unresolved identities
 * stay isolated even when a foreign source ID exists in the destination. */
export function rewriteImportReferenceContexts(value: unknown, identities: ImportIdentityMap): unknown {
  if (!Array.isArray(value)) throw new ImportDomainError("invalid_reference_contexts");
  return value.map(context => {
    if (!context || typeof context !== "object" || Array.isArray(context)) throw new ImportDomainError("invalid_reference_contexts");
    const row = context as Record<string, unknown>;
    if (!Array.isArray(row.segments)) throw new ImportDomainError("invalid_reference_contexts");
    return { ...row, segments: row.segments.map(segment => {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) throw new ImportDomainError("invalid_reference_contexts");
      const entry = segment as Record<string, unknown>;
      const target = entry.target as { kind?: unknown; sourceId?: unknown } | undefined;
      if (!target || !isResearchRecordKind(target.kind)) throw new ImportDomainError("invalid_reference_contexts");
      const type = Object.entries(REFERENCE_IMPORT_KINDS).find(([, kind]) => kind === target.kind)?.[0];
      if (!type || !["sample", "run", "run_step", "recipe_revision"].includes(type)) throw new ImportDomainError("invalid_reference_contexts");
      identity(target.sourceId);
      const id = identities.has(target.kind, target.sourceId) ? identities.get(target.kind, target.sourceId) : identities.register(target.kind, target.sourceId);
      return { type, id, label: entry.label, deletedAt: entry.deletedAt, archivedAt: entry.archivedAt };
    }) };
  });
}
