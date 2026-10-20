import type { ExportRow, ExportTables } from "./export";
import { checkedAcceptFileMigration, FILE_JOB_MAX_FILES, FILE_JOB_MAX_BYTES } from "./file-jobs";
import { stableJson } from "../domain/content-addressing";
import { FILE_JOBS_EXPORT_COLUMNS } from "./export-file-jobs-schema";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid File migration ${reason}`);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const key = (row: ExportRow) => stableJson([row.job_id, row.file_id]);
const nullableTime = (value: unknown) => value === null || time(value);
const nullableText = (value: unknown) => value === null || text(value);

/** Historical ownership and verified byte evidence are portable. Current
 * administrator authorization, leases and installation fences are not inferred
 * from these rows, and the live executor view is deliberately not serialized. */
export function validateFileJobHistory(tables: ExportTables) {
  for (const [name, columns] of Object.entries(FILE_JOBS_EXPORT_COLUMNS)) for (const row of tables[name])
    ensure(stableJson(Object.keys(row).sort()) === stableJson([...columns].sort()), `${name} columns`);
  const profiles = new Map(tables.storage_profiles.map(row => [row.id, row]));
  const files = new Map(tables.files.map(row => [row.id, row]));
  const locations = new Map(tables.file_locations.map(row => [row.id, row]));
  const publications = new Map(tables.file_location_publications.map(row => [row.location_id, row]));
  const jobs = new Map<unknown, ExportRow>(), items = new Map<string, ExportRow>();
  const requests = new Set<unknown>(), operations = new Set<unknown>(), attempts = new Set<unknown>();
  const candidateLocations = new Set<unknown>(), objectKeys = new Set<unknown>();
  const publishedLocations = new Set<string>();
  const moves: Array<{ fileId: string; source: string; destination: string }> = [];
  const cleanupAllows = (item: ExportRow, releasedAt: unknown) => time(item.cleanup_requested_at)
    && text(item.cleanup_actor) && time(item.cleanup_not_before) && time(releasedAt)
    && Date.parse(releasedAt) >= Date.parse(item.cleanup_requested_at)
    && Date.parse(releasedAt) >= Date.parse(item.cleanup_not_before);
  const neverWrittenCancellation = (job: ExportRow, item: ExportRow) => job.state === "cancelled" && item.state === "cancelled"
    && tables.file_migration_attempts.filter(row => key(row) === key(item)).every(row => row.write_started_at === null
      && ["failed", "cancelled"].includes(String(row.state)));
  for (const job of tables.file_migration_jobs) {
    ensure(text(job.id) && job.id.length <= 128 && !jobs.has(job.id) && text(job.request_id) && !requests.has(job.request_id)
      && text(job.actor) && job.actor.length <= 254 && time(job.accepted_at) && time(job.updated_at)
      && Date.parse(job.updated_at) >= Date.parse(job.accepted_at) && integer(job.generation)
      && ["queued", "running", "paused", "cancel_requested", "completed", "cancelled"].includes(String(job.state))
      && nullableText(job.owner_token) && nullableText(job.runtime_incarnation) && nullableTime(job.lease_expires_at)
      && nullableTime(job.admin_checked_at) && nullableText(job.reason), "job identity/state");
    ensure(job.state !== "running" || text(job.owner_token) && text(job.runtime_incarnation) && time(job.lease_expires_at), "recorded running claim");
    const profile = profiles.get(job.target_profile_id);
    ensure(profile && ["r2", "s3", "switchdrive"].includes(String(profile.adapter_type)) && profile.configuration_revision === job.target_configuration_revision
      && profile.namespace_identity === job.target_namespace, "frozen target namespace");
    let input: ReturnType<typeof checkedAcceptFileMigration>;
    try { input = checkedAcceptFileMigration(JSON.parse(String(job.input_json))); } catch { ensure(false, "accepted input"); }
    ensure(JSON.stringify(input) === job.input_json && input.requestId === job.request_id
      && input.target.profileId === job.target_profile_id && input.target.configurationRevision === job.target_configuration_revision,
    "canonical accepted decision");
    const selected = tables.file_migration_items.filter(row => row.job_id === job.id);
    ensure(selected.length > 0 && selected.length <= FILE_JOB_MAX_FILES
      && stableJson(selected.map(row => row.file_id).sort()) === stableJson(input.fileIds), "complete accepted selection");
    if (job.state === "completed") ensure(selected.every(row => !["pending", "copying"].includes(String(row.state))), "completed job items");
    jobs.set(job.id, job); requests.add(job.request_id);
  }
  for (const item of tables.file_migration_items) {
    const job = jobs.get(item.job_id), file = files.get(item.file_id), source = publications.get(item.source_location_id);
    const profile = profiles.get(item.source_profile_id), identity = key(item);
    ensure(job && file && source && profile && !items.has(identity) && text(item.hold_operation_id) && !operations.has(item.hold_operation_id)
      && source.file_id === item.file_id && source.storage_profile_id === item.source_profile_id
      && profile.configuration_revision === item.source_configuration_revision && profile.namespace_identity === item.source_namespace
      && source.object_key === item.source_object_key && item.source_profile_id !== job.target_profile_id
      && ["r2", "s3", "switchdrive"].includes(String(profile.adapter_type)) && file.access_scope === "system" && file.purpose === item.purpose
      && integer(item.byte_size) && item.byte_size <= FILE_JOB_MAX_BYTES && hash(item.sha256)
      && item.byte_size === file.expected_byte_size && item.sha256 === file.expected_sha256
      && item.byte_size === source.verified_byte_size && item.sha256 === source.verified_sha256
      && ["pending", "copying", "moved", "stale", "failed", "cancelled"].includes(String(item.state))
      && time(item.updated_at) && Date.parse(item.updated_at) >= Date.parse(String(job.accepted_at)) && nullableText(item.reason), "frozen source/item identity");
    ensure(nullableTime(item.cleanup_requested_at) && nullableText(item.cleanup_actor) && nullableTime(item.cleanup_not_before)
      && nullableTime(item.cleanup_released_at) && (item.cleanup_requested_at === null) === (item.cleanup_actor === null), "cleanup decision");
    if (item.cleanup_requested_at !== null) ensure(time(item.cleanup_not_before)
      && Date.parse(String(item.cleanup_requested_at)) >= Date.parse(String(job.accepted_at)), "accepted cleanup decision clock");
    if (item.cleanup_released_at !== null) ensure(cleanupAllows(item, item.cleanup_released_at), "released source grace");
    const sourceHolds = tables.file_location_holds.filter(row => row.operation_id === item.hold_operation_id
      && row.location_id === item.source_location_id && row.hold_kind === "transition_source");
    ensure(sourceHolds.length === 1 && sourceHolds[0].expires_at === null
      && (item.cleanup_released_at === null || sourceHolds[0].released_at !== null), "durable source hold coverage");
    if (sourceHolds[0].released_at !== null) {
      const selectedAttempts = tables.file_migration_attempts.filter(row => key(row) === identity);
      ensure(neverWrittenCancellation(job, item) || cleanupAllows(item, sourceHolds[0].released_at)
        && time(item.cleanup_released_at) && Date.parse(item.cleanup_released_at) >= Date.parse(String(sourceHolds[0].released_at)),
      "source hold release requires accepted cleanup and grace");
      ensure(selectedAttempts.every(row => row.state === "published" || row.write_started_at === null || time(row.io_settled_at)),
        "source hold cannot release uncertain written artifacts");
    }
    if (item.state === "moved") ensure(text(item.destination_location_id) && time(item.cleanup_not_before), "moved result");
    else ensure(item.destination_location_id === null, "unpublished item result");
    items.set(identity, item); operations.add(item.hold_operation_id);
    ensure(tables.file_migration_attempts.filter(row => key(row) === identity).length <= 5, "bounded candidate attempt inventory");
  }
  for (const attempt of tables.file_migration_attempts) {
    const job = jobs.get(attempt.job_id), item = items.get(key(attempt)), location = locations.get(attempt.location_id);
    ensure(job && item && location && text(attempt.id) && attempt.id.length <= 128 && !attempts.has(attempt.id)
      && !candidateLocations.has(attempt.location_id) && text(attempt.object_key) && !objectKeys.has(attempt.object_key)
      && location.file_id === attempt.file_id && location.storage_profile_id === job.target_profile_id
      && location.object_key === attempt.object_key && text(attempt.owner_token) && text(attempt.runtime_incarnation)
      && integer(attempt.generation) && attempt.generation <= Number(job.generation)
      && ["staged", "write_started", "unknown", "verified", "published", "failed", "cancelled"].includes(String(attempt.state))
      && time(attempt.created_at) && time(attempt.updated_at) && Date.parse(attempt.created_at) >= Date.parse(String(job.accepted_at))
      && Date.parse(attempt.updated_at) >= Date.parse(attempt.created_at) && nullableText(attempt.reason), "registered candidate/attempt identity");
    ensure(nullableTime(attempt.write_started_at) && nullableTime(attempt.io_settled_at) && nullableTime(attempt.verified_at), "attempt clocks");
    if (attempt.write_started_at !== null) ensure(Date.parse(String(attempt.write_started_at)) >= Date.parse(attempt.created_at), "write boundary clock");
    if (attempt.io_settled_at !== null) ensure(time(attempt.write_started_at)
      && Date.parse(String(attempt.io_settled_at)) >= Date.parse(attempt.write_started_at), "settled I/O clock");
    if (["write_started", "unknown", "verified", "published"].includes(String(attempt.state))) ensure(time(attempt.write_started_at), "durable write boundary");
    const destinationHolds = tables.file_location_holds.filter(row => row.operation_id === item.hold_operation_id
      && row.location_id === attempt.location_id && row.hold_kind === "transition_destination");
    const destinationMustRemain = ["staged", "write_started", "unknown", "verified"].includes(String(attempt.state))
      || attempt.write_started_at !== null && attempt.io_settled_at === null;
    ensure(destinationHolds.length === 1 && destinationHolds[0].expires_at === null
      && (!destinationMustRemain || destinationHolds[0].released_at === null), "candidate physical hold coverage");
    if (destinationHolds[0].released_at !== null && attempt.state !== "published") ensure(attempt.state === "cancelled"
      && (neverWrittenCancellation(job, item) || cleanupAllows(item, destinationHolds[0].released_at))
      && (attempt.write_started_at === null || time(attempt.io_settled_at)),
    "written artifact release requires accepted cleanup and grace");
    if (["verified", "published"].includes(String(attempt.state))) {
      ensure(time(attempt.io_settled_at) && time(attempt.verified_at) && Date.parse(attempt.verified_at) >= Date.parse(attempt.io_settled_at)
        && attempt.verified_byte_size === item.byte_size && attempt.verified_sha256 === item.sha256
        && text(attempt.verified_owner_token) && text(attempt.verified_runtime_incarnation)
        && integer(attempt.verified_generation) && attempt.verified_generation >= attempt.generation
        && attempt.verified_generation <= Number(job.generation), "independent byte verification");
    }
    const publication = publications.get(attempt.location_id);
    if (attempt.state === "published") {
      ensure(item.state === "moved" && item.destination_location_id === attempt.location_id && publication
        && publication.file_id === attempt.file_id && publication.storage_profile_id === job.target_profile_id
        && publication.object_key === attempt.object_key && publication.verification_method === "full_read_sha256"
        && publication.verification_operation_id === attempt.id && publication.verified_at === attempt.verified_at
        && publication.verified_sha256 === item.sha256 && publication.verified_byte_size === item.byte_size
        && Date.parse(String(publication.published_at)) >= Date.parse(String(attempt.verified_at)), "committed migration publication");
      ensure(destinationHolds[0].released_at === publication.published_at, "winner destination hold released at cutover");
      publishedLocations.add(String(attempt.location_id));
      moves.push({ fileId: String(attempt.file_id), source: String(item.source_location_id), destination: String(attempt.location_id) });
    } else ensure(!publication, "uncommitted attempt cannot publish");
    attempts.add(attempt.id); candidateLocations.add(attempt.location_id); objectKeys.add(attempt.object_key);
  }
  for (const item of items.values()) if (item.state === "moved") ensure(tables.file_migration_attempts.filter(row => key(row) === key(item)
    && row.state === "published" && row.location_id === item.destination_location_id).length === 1, "moved item winner coverage");
  return { publishedLocations, historicalResultLocation(fileId: unknown, source: unknown, destination: unknown) {
    const visited = new Set([String(source)]), pending = [String(source)];
    while (pending.length) {
      const current = pending.shift();
      for (const move of moves.filter(row => row.fileId === fileId && row.source === current)) {
        if (move.destination === destination) return true;
        if (!visited.has(move.destination)) { visited.add(move.destination); pending.push(move.destination); }
      }
    }
    return false;
  } };
}
