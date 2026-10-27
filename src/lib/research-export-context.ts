import { checkedResearchExportPlanInput, type ResearchExportKind } from "../../shared/contracts/research-package-api";

export interface ResearchPackageRoot { type: "sample" | "project"; id: string; label?: string }
export interface ProcessingExportOrigin {
  type: "processing";
  sampleId: string;
  runId?: string;
  additionalSampleIds?: readonly string[];
}
export interface ResearchExportContext {
  root: ResearchPackageRoot;
  kind: ResearchExportKind;
  sourcePath: string;
  processingPath: string | null;
}

function checkedRoot(type: unknown, id: unknown): ResearchPackageRoot | null {
  if (type !== "sample" && type !== "project" || typeof id !== "string" || id === "." || id === "..") return null;
  try {
    const input = checkedResearchExportPlanInput({ kind: "report", roots: [{ kind: type, id }] });
    return { type, id: input.roots[0].id };
  } catch { return null; }
}
function labelText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)
    || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) return undefined;
  return value.trim() || undefined;
}
function labelForLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 200) return labelText(normalized);
  const prefix = normalized.slice(0, 199).replace(/[\ud800-\udbff]$/, "");
  return labelText(`${prefix}…`);
}
function runIdentity(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  return new TextDecoder().decode(new TextEncoder().encode(value)) === value;
}
function one(query: URLSearchParams, key: string): string | null {
  const values = query.getAll(key);
  return values.length === 1 ? values[0] : null;
}
function additionalSamples(primaryId: string, values: readonly string[]): string[] {
  const seen = new Set([primaryId]);
  const ids: string[] = [];
  for (const value of values) {
    const id = value.trim();
    // The existing Processing `with` query represents IDs as a comma list.
    // These are view context, not export roots; preserve opaque internal spaces.
    if (!runIdentity(id) || id === "." || id === ".." || id.includes(",") || seen.has(id)) continue;
    seen.add(id); ids.push(id);
    if (ids.length === 7) break;
  }
  return ids;
}

/** Link metadata never changes export authority or starts work. Return paths
 * are generated from enumerated local routes, never accepted from the URL. */
export function researchExportHref(root: ResearchPackageRoot, kind: ResearchExportKind, origin?: ProcessingExportOrigin): string | null {
  const valid = checkedRoot(root.type, root.id);
  if (!valid) return null;
  const query = new URLSearchParams({ rootType: valid.type, rootId: valid.id, kind });
  const label = labelForLink(root.label);
  if (label) query.set("sourceLabel", label);
  if (origin?.type === "processing" && valid.type === "sample" && origin.sampleId === valid.id
    && (origin.runId === undefined || runIdentity(origin.runId))) {
    query.set("from", "processing");
    if (origin.runId !== undefined) query.set("runId", origin.runId);
    for (const id of additionalSamples(valid.id, origin.additionalSampleIds ?? [])) query.append("sourceWith", id);
  }
  return `/settings/data?${query}`;
}

export function readResearchExportContext(query: URLSearchParams): ResearchExportContext | null {
  const root = checkedRoot(one(query, "rootType"), one(query, "rootId"));
  const kinds = query.getAll("kind");
  if (!root || kinds.length > 1 || kinds.length === 1 && kinds[0] !== "report" && kinds[0] !== "data_package") return null;
  const label = labelText(one(query, "sourceLabel"));
  if (label) root.label = label;
  const kind = kinds[0] === "report" ? "report" : "data_package";
  let processingPath: string | null = null;
  const runs = query.getAll("runId");
  if (root.type === "sample" && one(query, "from") === "processing" && runs.length <= 1
    && (!runs.length || runIdentity(runs[0]))) {
    processingPath = `/processing/${encodeURIComponent(root.id)}`;
    const returnQuery = new URLSearchParams();
    if (runs.length) returnQuery.set("run", runs[0]);
    const additional = additionalSamples(root.id, query.getAll("sourceWith"));
    if (additional.length) returnQuery.set("with", additional.join(","));
    if (returnQuery.size) processingPath += `?${returnQuery}`;
  }
  return { root, kind, sourcePath: `/${root.type === "sample" ? "samples" : "projects"}/${encodeURIComponent(root.id)}`, processingPath };
}

export function researchExportContextKey(context: ResearchExportContext | null): string {
  return context ? JSON.stringify([context.root.type, context.root.id, context.root.label ?? null, context.kind, context.processingPath]) : "";
}

export function researchExportScopeMatches(context: ResearchExportContext, rootText: string): boolean {
  const lines = rootText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length === 1 && lines[0] === `${context.root.type}:${context.root.id}`;
}
