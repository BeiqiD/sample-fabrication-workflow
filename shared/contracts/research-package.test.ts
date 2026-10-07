import { describe, expect, it } from "vitest";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "./research-package-catalog";
import { type ResearchDomainRecord, type ResearchPackageFile, type ResearchPackageManifestV1, validateResearchPackage,
  researchRecordsDocument, RESEARCH_PACKAGE_MAX_RECORD_BYTES, checkedResearchDomainRecord,
  RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES, checkedResearchPackageManifest, checkedResearchReportManifest } from "./research-package";
import { hashStateRepresentation, hashStepDefinition, hashRecipeManifest, sha256Hex, stableJson } from "../domain/content-addressing";
import { renderResearchPackageReport } from "../domain/research-report";
import { validateResearchDomainRelations } from "./research-package-relations";

const now = "2026-10-06T12:00:00.000Z";
function record(kind: ResearchRecordKind, sourceId: string, overrides: Record<string, unknown> = {}): ResearchDomainRecord {
  const definition = RESEARCH_PACKAGE_CATALOG[kind];
  const data = Object.fromEntries(Object.entries(definition.fields).map(([key, rule]) => {
    const value = rule.nullable ? null : rule.type === "integer" || rule.type === "number" ? 1
      : rule.type === "json" ? {} : rule.values?.[0] ?? (key.endsWith("_at") ? now : "value");
    return [key, value];
  }));
  Object.assign(data, overrides);
  if (definition.revision.field && definition.revision.scheme === "timestamp") data[definition.revision.field] = now;
  const revisionValue = definition.revision.scheme === "contentHash" ? sourceId : definition.revision.scheme === "integer" ? data[definition.revision.field!] as number : now;
  return { kind, sourceId, sourceRevision: { scheme: definition.revision.scheme, value: revisionValue }, data };
}
async function envelope(records: ResearchDomainRecord[], files: ResearchPackageFile[] = []) {
  const manifest: ResearchPackageManifestV1 = { schema: "research-package/1", kind: "data_package", packageId: "package", sourceInstallationId: "opaque-installation",
    createdAt: now, roots: [{ kind: "sample", id: "sample" }], recordsSha256: await sha256Hex(stableJson(researchRecordsDocument(records))), files, dependencies: [],
    completeness: "complete", counts: { records: records.length, files: files.length, bytes: files.reduce((sum, file) => sum + file.byteSize, 0) },
    report: { htmlPath: "report/index.html", markdownPath: "report/report.md" } };
  return { manifest, document: researchRecordsDocument(records) };
}
const sample = () => record("sample", "sample", { code: "SAMPLE", title: "Research sample", status: "stored", pinned: 0 });

describe("closed public research package domain", () => {
  it("validates independent domain metadata without SQL/schema/provider addresses", async () => {
    const input = await envelope([sample()]); await expect(validateResearchPackage(input.manifest, input.document)).resolves.toMatchObject({ kind: "data_package" });
    await expect(validateResearchPackage({ ...input.manifest, schemaSql: "CREATE TABLE x" }, input.document)).rejects.toThrow("fields");
    await expect(validateResearchPackage({ ...input.manifest, kind: "report", schema: "research-report/1" }, input.document)).rejects.toThrow("schema");
  });
  it("rejects source record bodies over the shared 64 KiB admission bound", () => {
    expect(() => checkedResearchDomainRecord(record("sample", "sample", { description: "x".repeat(RESEARCH_PACKAGE_MAX_RECORD_BYTES) }))).toThrow("record_limit");
  });
  it.each(["asset", "managed"])("rejects impossible NULL %s alias presentation before copy", kind => {
    const alias = record("fileAlias", `${kind}:alias`, { alias_kind: kind, packageFileId: "alias", original_name: "source.png", mime_type: "image/png" });
    expect(() => checkedResearchDomainRecord({ ...alias, data: { ...alias.data, original_name: null } })).toThrow("text_field");
    expect(() => checkedResearchDomainRecord({ ...alias, data: { ...alias.data, mime_type: null } })).toThrow("text_field");
  });
  it("rejects identities and physical text that cannot roundtrip through UTF-8 before rendering or copy", () => {
    expect(() => checkedResearchDomainRecord(record("sample", "\ud800"))).toThrow("identity");
    expect(() => checkedResearchDomainRecord(record("sample", "sample", { code: "\ud800" }))).toThrow("text_field");
    expect(checkedResearchDomainRecord(record("sample", "sample", { code: "Research 🧪", title: "First\nSecond" })).data)
      .toMatchObject({ code: "Research 🧪", title: "First\nSecond" });
  });
  it("bounds the standalone manifest within the shared 1 MiB persistence budget", async () => {
    const { manifest } = await envelope([sample()]);
    const dependency = { owner: { kind: "sample", sourceId: "o".repeat(256) }, field: "f".repeat(256),
      target: { kind: "sample", sourceId: "t".repeat(256) }, resolution: "excluded", reason: "outside_selected_roots" };
    const oversized = { ...manifest, dependencies: Array.from({ length: 1_500 }, () => dependency) };
    expect(new TextEncoder().encode(stableJson(oversized)).byteLength).toBeGreaterThan(RESEARCH_PACKAGE_MAX_PERSISTED_MANIFEST_BYTES);
    expect(() => checkedResearchPackageManifest(oversized)).toThrow("manifest_limit");
    expect(() => checkedResearchReportManifest({ ...oversized, schema: "research-report/1", kind: "report" })).toThrow("manifest_limit");
  });
  it("rejects non-domain enums before provider I/O", async () => {
    const input = await envelope([record("sample", "sample", { status: "banana", pinned: 0 })]);
    await expect(validateResearchPackage(input.manifest, input.document)).rejects.toThrow("enum");
  });
  it("rejects unsafe Project source and Comment link URLs using normal ingress rules", () => {
    const content = record("projectContent", "content", { content_type: "attachment", markdown_source: null,
      attachment_source_url: "javascript:alert(1)", attachment_caption: "Source context" });
    expect(() => validateResearchDomainRelations([content], [])).toThrow("project_content_text");
    expect(() => validateResearchDomainRelations([{ ...content, data: { ...content.data, attachment_source_url: "https://example.test/research" } }], [])).not.toThrow();
    const link = record("commentItem", "link", { kind: "link", status: "ready", external_url: "data:text/html,active" });
    expect(() => validateResearchDomainRelations([link], [])).toThrow("comment_link_url");
    expect(() => validateResearchDomainRelations([{ ...link, data: { ...link.data, external_url: "https://example.test/paper" } }], [])).not.toThrow();
  });
  it("rejects mismatched inventory digests, duplicate identities, and path traversal", async () => {
    const input = await envelope([sample()]);
    await expect(validateResearchPackage({ ...input.manifest, recordsSha256: "a".repeat(64) }, input.document)).rejects.toThrow("records_digest");
    const duplicate = await envelope([sample(), sample()]); await expect(validateResearchPackage(duplicate.manifest, duplicate.document)).rejects.toThrow("record_duplicate");
    await expect(validateResearchPackage({ ...input.manifest, files: [{ packageFileId: "one", path: "../secret", purpose: "embedded_content", byteSize: 0, sha256: "a".repeat(64), mediaType: null }] }, input.document)).rejects.toThrow("file");
  });
  it("validates semantic definition hash schemes rather than accepting a hash-shaped ID", async () => {
    const definition = await hashStepDefinition({ name: "Verified name" });
    const good = record("stepDefinition", definition.hash, { hash_scheme: "step-definition/v1", name: "Verified name", canonical_json: definition.canonical });
    const input = await envelope([sample(), good]); await expect(validateResearchPackage(input.manifest, input.document)).resolves.toBeDefined();
    const bad = await envelope([sample(), { ...good, data: { ...good.data, hash_scheme: "sha256/arbitrary" } }]);
    await expect(validateResearchPackage(bad.manifest, bad.document)).rejects.toThrow("definition_hash");
  });
  it("keeps recipe provenance closed and source staging IDs out of live JSON context", async () => {
    const family = record("recipeFamily", "family", { name: "Fixture recipe", template_type: "module" });
    const recipe = record("recipeRevision", "recipe", { recipe_family_id: "family", template_type: "module", template_kind: "process",
      manifest_hash: await hashRecipeManifest([]), content_json: { initialSubstrateStep: null,
        provenance: { schemaVersion: 1, importedTitle: "Recipe", objectKind: "module", warningCount: 0 } } });
    const good = await envelope([sample(), family, recipe]); await expect(validateResearchPackage(good.manifest, good.document)).resolves.toBeDefined();
    const bad = await envelope([sample(), family, { ...recipe, data: { ...recipe.data, content_json: {
      ...recipe.data.content_json as object, initialSubstrateStep: { localId: "source-staging-id", imageIds: ["source-provider-alias"] },
    } } }]);
    await expect(validateResearchPackage(bad.manifest, bad.document)).rejects.toThrow("fields");
  });
  it("preserves two aliases with ordered duplicate byte content and rejects ambiguous position ties", async () => {
    const sha = await sha256Hex("bytes"), state = await hashStateRepresentation([sha, sha]);
    const files: ResearchPackageFile[] = ["a", "b"].map(id => ({ packageFileId: id, path: `files/${id}`, purpose: "embedded_content", byteSize: 5, sha256: sha, mediaType: "image/png" }));
    const stateRecord = record("state", state.hash, { hash_scheme: "state-diagram/v1", representation_type: "diagram", content_json: state.canonical });
    const aliases = ["a", "b"].map(id => record("fileAlias", `asset:${id}`, { alias_kind: "asset", packageFileId: id, original_name: `${id}.png`, mime_type: "image/png", byte_size: 5, sha256: sha }));
    const associations = ["a", "b"].map((id, position) => record("stateAsset", JSON.stringify([state.hash, `asset:${id}`]), { state_hash: state.hash, asset_id: `asset:${id}`, position, packageFileId: id }));
    const input = await envelope([sample(), stateRecord, ...aliases, ...associations], files);
    await expect(validateResearchPackage(input.manifest, input.document)).resolves.toMatchObject({ files: [{ packageFileId: "a" }, { packageFileId: "b" }] });
    const tie = await envelope([sample(), stateRecord, ...aliases, ...associations.map(record => ({ ...record, data: { ...record.data, position: 0 } }))], files);
    await expect(validateResearchPackage(tie.manifest, tie.document)).rejects.toThrow("duplicate_domain_key");
  });
  it("rejects executable foreign source locators on public File inventory", async () => {
    const input = await envelope([sample()]);
    await expect(validateResearchPackage({ ...input.manifest, files: [{ packageFileId: "x", path: "files/x", purpose: "research_source", byteSize: 0,
      sha256: "a".repeat(64), mediaType: null, objectKey: "provider/private" }] }, input.document)).rejects.toThrow("fields");
  });
  it("preserves NULL purpose rules on historical image, metrology, and Project attachment slots", async () => {
    const sha = await sha256Hex("historical bytes");
    const files: ResearchPackageFile[] = ["image", "metrology", "attachment"].map(packageFileId => ({ packageFileId,
      path: `files/${packageFileId}`, byteSize: 16, sha256: sha, purpose: "provenance", mediaType: "image/png" }));
    const records = [...files.map(file => record("fileAlias", `asset:${file.packageFileId}`, { alias_kind: "asset", packageFileId: file.packageFileId,
      byte_size: file.byteSize, sha256: file.sha256 })),
      record("executionImage", "image", { asset_id: "asset:image", packageFileId: "image", role: "execution" }),
      record("metrologyReference", "metrology", { asset_id: "asset:metrology", packageFileId: "metrology" }),
      record("projectAttachment", "attachment", { project_content_id: "attachment", asset_id: "asset:attachment", packageFileId: "attachment" })];
    expect(() => validateResearchDomainRelations(records, files)).not.toThrow();
    const strict = record("stateAsset", JSON.stringify(["state", "asset:image"]), { state_hash: "state", asset_id: "asset:image", position: 0, packageFileId: "image" });
    expect(() => validateResearchDomainRelations([...records, strict], files)).toThrow("file_purpose");
  });
  it("keeps reports inert with escaped source prose and relative offline File links", async () => {
    const source = sample(); source.data.title = "<script>alert(1)</script>";
    const input = await envelope([source]); const snapshot = await validateResearchPackage(input.manifest, input.document);
    const report = renderResearchPackageReport(snapshot);
    expect(report.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); expect(report.html).not.toContain("<script>");
    expect(report.html).toContain("default-src 'none'"); expect(report.html).not.toContain("srcdoc");
    expect(report.markdown).toContain("\\<script\\>");
  });
  it("renders Project references with all captured Sample and Run history, shared Comment contexts, and graph details", async () => {
    const records = [record("project", "project", { title: "Project reading" }), sample(),
      record("run", "run", { sample_id: "sample", template_name_snapshot: "Run history", sequence_no: 1 }),
      record("runStep", "step-one", { run_id: "run", position: 0, notes: "First step history" }),
      record("runStep", "step-two", { run_id: "run", position: 1, notes: "Second step history" }),
      record("comment", "shared", { context_kind: "run_steps", scope: "common", body: "One canonical reading body" }),
      ...["one", "two"].map(suffix => record("commentOccurrence", `occurrence-${suffix}`, { submission_id: "shared", run_step_id: `step-${suffix}` })),
      record("reference", "sample-reference", { target: { kind: "sample", sourceId: "sample" }, resolution: "included", contexts: [] }),
      record("reference", "run-reference", { target: { kind: "run", sourceId: "run" }, resolution: "included", contexts: [] }),
      record("projectItem", "sample-item", { project_id: "project", item_type: "reference", reference_target_id: "sample-reference", created_sequence: 1 }),
      record("projectItem", "run-item", { project_id: "project", item_type: "reference", reference_target_id: "run-reference", created_sequence: 2 }),
      record("projectEdge", "edge", { project_id: "project", source_item_id: "sample-item", target_item_id: "run-item", label: "Measured transition", marker_start: "none", marker_end: "arrowclosed" })];
    const { manifest } = await envelope(records);
    const report = renderResearchPackageReport({ ...manifest, roots: [{ kind: "project", id: "project" }], records });
    expect(report.html).toContain("First step history"); expect(report.html).toContain("Second step history");
    expect(report.html.match(/One canonical reading body/g)).toHaveLength(1);
    expect(report.html.match(/Comment context:/g)).toHaveLength(2);
    expect(report.html).toContain('href="#record-runStep-step-one"'); expect(report.html).toContain('href="#record-runStep-step-two"');
    expect(report.html).toContain("Captured Project graph"); expect(report.html).toContain("Measured transition");
    for (const source of records) expect(report.html).toContain(`id="record-${source.kind}-${encodeURIComponent(source.sourceId)}"`);
    expect(report.markdown).toContain("First step history"); expect(report.markdown).toContain("Measured transition");
  });
});
