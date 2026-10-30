import type { FilePurpose } from "../../shared/contracts/files";
import type { AuthorityCandidateOwner, StagedAuthorityCandidate } from "../files/authority-candidates-core";
import type { NativeAssetAliasInput } from "../files/native-asset-alias-core";
import type { VerifiedAuthorityPublication } from "../files/authority-publication-core";
import type { ByteReader } from "../files/byte-reader";

/** Complete algorithm ports over an already-owned engine/provider graph.
 * These structural types do not issue Request, resource or File permission. */
export interface CommentAcceptanceStatement<Statement> {
  bind(...values: unknown[]): Statement;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }>;
}
export interface CommentAcceptanceDatabase<Statement extends CommentAcceptanceStatement<Statement>> {
  prepare(sql: string): Statement;
  primary(): CommentAcceptanceDatabase<Statement>;
  batch(statements: Statement[]): Promise<{ results: Record<string, unknown>[] }[]>;
}
interface Profile { readonly id: string; readonly configurationRevision: 1 }
interface Selection<Statement> {
  readonly selectionRevision?: number | null;
  readonly statements: Statement[];
  profileFor(purpose: FilePurpose): Profile;
}
interface ExpectedBytes { sha256: string; byteSize: number }
interface LegacyIngestionInput {
  originalName: string; mimeType: string; actorEmail: string;
  registrationId: string; objectKey(): string;
}
interface LegacyIngestionResult {
  handle: { blobRecordId: string; objectKey: string; sha256: string; byteSize: number };
  deduplicated: boolean;
}
/** Keeps the one original managed provider instance selected by the Worker. */
export interface ManagedCommentStorage {
  readonly reader: ByteReader;
  ingest(input: LegacyIngestionInput & { body: ReadableStream; byteSize: number; sha256: string }): Promise<LegacyIngestionResult>;
}
export interface CommentAcceptancePorts<Statement extends CommentAcceptanceStatement<Statement>> {
  readonly database: CommentAcceptanceDatabase<Statement>;
  /** Omission preserves the original closed S3 selection and SQL. A selection
   * is algorithm input only, never a Request/provider/resource grant. */
  readonly nativeAssetAdapter?: "s3" | "local";
  objectName(name: string): string;
  managedObjectKey(submission: string, item: string, filename: string, sample?: { id: string; code: string }): string;
  authorityMode(database: CommentAcceptanceDatabase<Statement>): Promise<"legacy" | "overlap" | "active">;
  acceptanceModeFence(database: CommentAcceptanceDatabase<Statement>, mode: "legacy" | "overlap" | "active"): Statement;
  selectRoles(database: CommentAcceptanceDatabase<Statement>, purposes: readonly FilePurpose[], now: string): Promise<Selection<Statement>>;
  ensureR2Profile(database: CommentAcceptanceDatabase<Statement>, now: string): Promise<Profile>;
  ensureManagedProfile(database: CommentAcceptanceDatabase<Statement>, now: string): Promise<Profile>;
  assertR2Profile(database: CommentAcceptanceDatabase<Statement>, id: string, revision: number): Promise<unknown>;
  assertManagedProfile(database: CommentAcceptanceDatabase<Statement>, id: string, revision: number): Promise<unknown>;
  verifyAcceptedFile(input: { purpose: FilePurpose; expectedBytes: ExpectedBytes; resolveFileId(): Promise<string | null> }): Promise<boolean>;
  r2Reader(): ByteReader;
  managedStorage(): ManagedCommentStorage | null;
  verifyLegacyBytes(body: ReadableStream, expected: ExpectedBytes): Promise<unknown>;
  verifyOriginalUploadBody(body: ReadableStream<Uint8Array>, expected: ExpectedBytes): Promise<unknown>;
  boundedBody(request: Request, maximum: number): Promise<ArrayBuffer>;
  ingestR2(input: LegacyIngestionInput & { bytes: ArrayBuffer }): Promise<LegacyIngestionResult>;
  isLegacyHashMismatch(error: unknown): boolean;
  isLegacyByteSizeMismatch(error: unknown): boolean;
  stageCandidate(database: CommentAcceptanceDatabase<Statement>, owner: AuthorityCandidateOwner): Promise<StagedAuthorityCandidate>;
  writeCandidate(owner: AuthorityCandidateOwner, candidate: StagedAuthorityCandidate,
    input: { body: ArrayBuffer | ReadableStream<Uint8Array>; contentType: string; filename: string }): Promise<{
      result: VerifiedAuthorityPublication["result"]; statements: Statement[];
    }>;
  nativeAlias(database: CommentAcceptanceDatabase<Statement>, input: NativeAssetAliasInput): Statement;
}
export interface CommentAcceptanceRequest<Statement extends CommentAcceptanceStatement<Statement>> {
  readonly ports: CommentAcceptancePorts<Statement>;
  readonly request: Request;
  readonly actor: string;
  readonly parameters: { readonly submissionId?: string; readonly itemId?: string };
}
export interface CommentAcceptanceReply<Value = unknown> {
  readonly value: Value;
  readonly status: number;
  readonly cacheControl: "no-store";
}
export function commentAcceptanceReply<Value>(value: Value, status = 200): CommentAcceptanceReply<Value> {
  return { value, status, cacheControl: "no-store" };
}
