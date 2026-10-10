import { RESEARCH_PACKAGE_CATALOG } from "../../shared/contracts/research-package-catalog";
import { isProjectTitle } from "../../shared/contracts/project-api";
import type { ResearchPackageV1 } from "../../shared/contracts/research-package";
import type { JobSqlDatabase } from "../files/jobs/sql-repository";
import type { ImportDestinationColumn, ImportDestinationSnapshot, ImportDestinationStateMedia } from "./import-domain-types";
import { ImportDomainError } from "./import-domain-identity";
import { hasRecoveryAssetAliasEvidence, qualifiedRecoveryLegacyAssetAliasSql } from "../files/native-asset-alias";

/** The finite suffix space is part of preview qualification, not an unbounded
 * scan of destination business rows. Exhaustion is an explicit preflight error. */
export function importNameCandidates(value: string): string[] {
  return [value, ...Array.from({ length: 64 }, (_, index) => `${value} (import ${index + 1})`)];
}

/** Schema-only discovery is shared by source supported-copy admission. It does
 * not inspect destination business names, media or canonical definitions. */
export async function readImportDestinationColumns(database: JobSqlDatabase, pkg: ResearchPackageV1): Promise<ImportDestinationSnapshot["columns"]> {
  const db = database.primary();
  const kinds = [...new Set(pkg.records.filter(row => row.kind !== "fileAlias" && row.kind !== "fileDerivation" && row.kind !== "attachmentDerivative").map(row => row.kind))];
  const tables = [...new Set(kinds.map(kind => RESEARCH_PACKAGE_CATALOG[kind].table))];
  const schema = await db.prepare(`SELECT s.name AS table_name,p.name,p."notnull" AS not_null,p.dflt_value
    FROM sqlite_schema s JOIN pragma_table_info(s.name) p WHERE s.type='table'
    AND s.name IN(SELECT value FROM json_each(?)) ORDER BY s.name,p.cid`).bind(JSON.stringify(tables))
    .all<{ table_name: string; name: string; not_null: number; dflt_value: string | null }>();
  const columns: Record<string, ImportDestinationColumn[]> = {};
  for (const row of schema.results) (columns[row.table_name] ??= []).push({ name: row.name, notNull: row.not_null === 1, defaultValue: row.dflt_value });
  return columns;
}

export async function readImportDestinationSnapshot(database: JobSqlDatabase, pkg: ResearchPackageV1, options: { namingSuffix?: string } = {}): Promise<ImportDestinationSnapshot> {
  const db = database.primary();
  const suffix = options.namingSuffix ?? "";
  if (suffix.length > 32 || /[\u0000-\u001f\u007f]/.test(suffix)) throw new ImportDomainError("invalid_naming_suffix");
  const columns = await readImportDestinationColumns(database, pkg);
  // Historical supported-copy schemas have no portable FP5 evidence tables.
  // Only a reviewed current schema can add the exact recovery-origin branch.
  const recoveredStateAlias = await hasRecoveryAssetAliasEvidence(db)
    ? `(sa.file_id=f.file_id AND ${qualifiedRecoveryLegacyAssetAliasSql("a", "f", { stateAlias: "sa" })})` : "0";
  const names = (kind: "sample" | "recipeFamily" | "recipeRevision" | "project", field: string) => [...new Set(pkg.records
    .filter(row => row.kind === kind).map(row => {
      const name = String(row.data[field]) + suffix;
      if (name.length > 1000 || kind === "project" && !isProjectTitle(name)) throw new ImportDomainError("destination_name_limit");
      return name;
    }))];
  async function matchingNames<T>(table: string, field: string, columns: string, candidates: string[]): Promise<{ results: T[] }> {
    const groups: string[][] = []; let group: string[] = [], length = 2;
    for (const name of candidates) {
      const size = new TextEncoder().encode(JSON.stringify(name)).byteLength + 1;
      if (length + size > 96 * 1024) { groups.push(group); group = []; length = 2; }
      group.push(name); length += size;
    }
    if (group.length) groups.push(group);
    const results: T[] = [];
    for (const values of groups) {
      // Generate the finite suffix space in SQL rather than expanding every
      // source name65times in a D1 parameter. Indexed exact-name joins avoid a
      // scan of unrelated destination entities. Excessive conflicts refuse the
      // preview explicitly rather than truncating collision evidence.
      const result = await db.prepare(`WITH RECURSIVE suffix(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM suffix WHERE n<64),
        wanted(name) AS(SELECT CASE WHEN n=0 THEN base.value ELSE base.value||' (import '||n||')' END FROM json_each(?) base CROSS JOIN suffix)
        SELECT ${columns} FROM ${table} target JOIN wanted ON target.${field}=wanted.name LIMIT 4097`).bind(JSON.stringify(values)).all<T>();
      if (result.results.length > 4096) throw new ImportDomainError("destination_name_preflight_limit");
      results.push(...result.results);
    }
    return { results };
  }
  const definitions = pkg.records.filter(row => row.kind === "state" || row.kind === "stepDefinition");
  const [samples, families, revisions, projects, states, steps, media] = await Promise.all([
    matchingNames<{ code: string }>("samples", "code", "target.code", names("sample", "code")),
    matchingNames<{ name: string; template_type: string }>("recipe_families", "name", "target.name,target.template_type", names("recipeFamily", "name")),
    matchingNames<{ name: string; template_type: string; version: number }>("template_versions", "name", "target.name,target.template_type,target.version", names("recipeRevision", "name")),
    matchingNames<{ title: string }>("projects", "title", "target.title", names("project", "title")),
    db.prepare("SELECT * FROM state_representations WHERE hash IN(SELECT value FROM json_each(?))").bind(JSON.stringify(definitions.filter(row => row.kind === "state").map(row => row.sourceId))).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM step_definitions WHERE hash IN(SELECT value FROM json_each(?))").bind(JSON.stringify(definitions.filter(row => row.kind === "stepDefinition").map(row => row.sourceId))).all<Record<string, unknown>>(),
    db.prepare(`SELECT sa.state_hash AS stateHash,sa.position,sa.asset_id AS assetId,COALESCE(sa.file_id,a.file_id) AS fileId,
      f.active_location_id AS locationId,f.purpose,f.access_scope AS scope,l.storage_profile_id AS profileId,
      p.configuration_revision AS profileRevision,p.namespace_identity AS namespaceIdentity,
      f.verified_sha256 AS sha256,f.verified_byte_size AS byteSize
      FROM state_representation_assets sa LEFT JOIN assets a ON a.id=sa.asset_id AND a.status='ready'
      LEFT JOIN file_usable_publications f ON f.file_id=COALESCE(sa.file_id,a.file_id) AND a.byte_size=f.verified_byte_size
      AND((a.file_id=f.file_id AND(sa.file_id IS NULL OR sa.file_id=a.file_id) AND a.sha256=f.verified_sha256
        AND EXISTS(SELECT 1 FROM file_location_publications original WHERE original.file_id=a.file_id
          AND original.storage_profile_id=a.storage_profile_id AND original.object_key=a.object_key
          AND original.verified_sha256=a.sha256 AND original.verified_byte_size=a.byte_size))
        OR(a.file_id IS NULL AND a.r2_key IS NOT NULL AND sa.file_id=f.file_id
          AND(a.sha256 IS NULL OR a.sha256=f.verified_sha256) AND EXISTS(SELECT 1 FROM legacy_file_mappings mapped
            WHERE mapped.store_kind='r2' AND mapped.provider='r2' AND mapped.object_key=a.r2_key AND mapped.file_id=f.file_id))
        OR ${recoveredStateAlias})
      LEFT JOIN file_location_publications l ON l.location_id=f.active_location_id
      LEFT JOIN storage_profiles p ON p.id=l.storage_profile_id
      WHERE sa.state_hash IN(SELECT value FROM json_each(?)) ORDER BY sa.state_hash,sa.position,sa.asset_id`)
      .bind(JSON.stringify(definitions.filter(row => row.kind === "state").map(row => row.sourceId))).all<ImportDestinationStateMedia>(),
  ]);
  return { columns, names: { sample: samples.results.map(row => row.code), recipeFamily: families.results.map(row => ({ name: row.name, type: row.template_type })),
    recipeRevision: revisions.results.map(row => ({ name: row.name, type: row.template_type, version: row.version })), project: projects.results.map(row => row.title) },
    definitions: [...states.results.map(data => ({ kind: "state" as const, hash: String(data.hash), data })),
      ...steps.results.map(data => ({ kind: "stepDefinition" as const, hash: String(data.hash), data }))], stateMedia: media.results };
}
