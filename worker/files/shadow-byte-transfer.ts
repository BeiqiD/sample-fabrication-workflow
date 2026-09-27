import type { ByteReader } from "./byte-reader";
import { writeVerifiedBytes, type ByteWriter } from "./byte-writer";
import {
  ByteVerificationError, validateByteExpectation, verifyByteStream,
  type ByteExpectation, type Sha256Factory, type VerificationPhase,
  type VerificationReason, type VerifiedBytes,
} from "./byte-verification";

/** An already-selected physical instance. The caller must establish that these
 * labels describe the supplied capabilities; this module cannot resolve a
 * profile, authorize a write, pin a provider version or acquire retention. */
export interface ShadowStorageIdentity {
  readonly profileId: string;
  readonly configurationRevision: number;
  readonly adapterType: string;
  readonly namespaceIdentity: string;
}
export interface ShadowByteTarget {
  readonly storage: ShadowStorageIdentity;
  readonly objectKey: string;
}
export interface BoundShadowReader {
  readonly storage: ShadowStorageIdentity;
  readonly reader: Pick<ByteReader, "read">;
}
export interface ShadowReadStorage extends BoundShadowReader {
  readonly createHash: Sha256Factory;
}
export interface ShadowCopyStorage {
  readonly source: BoundShadowReader;
  readonly destination: BoundShadowReader & { readonly writer: ByteWriter };
  readonly createHash: Sha256Factory;
}
export interface ShadowReadInput {
  readonly target: ShadowByteTarget;
  readonly expected: ByteExpectation;
}
export interface ShadowCopyInput {
  readonly source: ShadowByteTarget;
  readonly destination: ShadowByteTarget;
  readonly expected: ByteExpectation;
  readonly contentType: string;
  readonly filename: string;
}
export interface ShadowByteEvidence {
  readonly target: ShadowByteTarget;
  readonly bytes: Readonly<VerifiedBytes>;
}
export interface ShadowCopyEvidence {
  readonly kind: "copied";
  readonly source: ShadowByteEvidence;
  readonly destination: ShadowByteEvidence;
}
export interface ShadowExistingEvidence extends ShadowByteEvidence {
  readonly kind: "verified_existing";
}
export interface ShadowReconciledEvidence extends ShadowByteEvidence {
  readonly kind: "reconciled_destination";
}
export type ShadowTransferReason = VerificationReason | "invalid_binding"
  | "same_location" | "unsupported_writer";

/** A write may have committed even when source verification subsequently fails.
 * A false flag only means this invocation did not call the writer. Neither flag
 * grants permission to retry, delete or publish a candidate. */
export class ShadowByteTransferError extends Error {
  constructor(
    readonly phase: VerificationPhase | "binding",
    readonly reason: ShadowTransferReason,
    readonly writeMayHaveCommitted: boolean,
  ) {
    super("Shadow file bytes could not be verified.");
    this.name = "ShadowByteTransferError";
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function identity(value: ShadowStorageIdentity): ShadowStorageIdentity {
  if (!value || !text(value.profileId) || !text(value.adapterType)
    || !text(value.namespaceIdentity) || !Number.isSafeInteger(value.configurationRevision)
    || value.configurationRevision < 1) {
    throw new ShadowByteTransferError("binding", "invalid_binding", false);
  }
  return Object.freeze({ profileId: value.profileId, adapterType: value.adapterType,
    namespaceIdentity: value.namespaceIdentity, configurationRevision: value.configurationRevision });
}

function target(value: ShadowByteTarget): ShadowByteTarget {
  if (!value || !text(value.objectKey)) throw new ShadowByteTransferError("binding", "invalid_binding", false);
  return Object.freeze({ storage: identity(value.storage), objectKey: value.objectKey });
}

function bindReader(bound: BoundShadowReader, expected: ShadowStorageIdentity): Pick<ByteReader, "read"> {
  const actual = identity(bound.storage);
  if (actual.profileId !== expected.profileId || actual.configurationRevision !== expected.configurationRevision
    || actual.adapterType !== expected.adapterType || actual.namespaceIdentity !== expected.namespaceIdentity) {
    throw new ShadowByteTransferError("binding", "invalid_binding", false);
  }
  // Capture methods and locator values before the first await. Changing a
  // caller-owned object mid-transfer must not retarget the readback or evidence.
  return { read: bound.reader.read.bind(bound.reader) };
}

function expectation(value: ByteExpectation, phase: VerificationPhase): Readonly<ByteExpectation> {
  const result = Object.freeze({ byteSize: value.byteSize, sha256: value.sha256 });
  validateByteExpectation(result, phase);
  return result;
}

function failure(error: unknown, writeMayHaveCommitted: boolean, phase: VerificationPhase) {
  if (error instanceof ShadowByteTransferError) {
    return new ShadowByteTransferError(error.phase, error.reason, writeMayHaveCommitted);
  }
  if (error instanceof ByteVerificationError) {
    return new ShadowByteTransferError(error.phase, error.reason, writeMayHaveCommitted);
  }
  return new ShadowByteTransferError(phase, "unavailable", writeMayHaveCommitted);
}

async function readBody(reader: Pick<ByteReader, "read">, key: string, phase: VerificationPhase) {
  let result;
  try { result = await reader.read(key); }
  catch { throw new ByteVerificationError(phase, "unavailable"); }
  if (result.outcome !== "available") throw new ByteVerificationError(phase, "unavailable");
  return result.body;
}

function evidence(location: ShadowByteTarget, bytes: VerifiedBytes): ShadowByteEvidence {
  return Object.freeze({ target: location, bytes: Object.freeze({ byteSize: bytes.byteSize, sha256: bytes.sha256 }) });
}

/** One streamed copy and one full destination readback. Before calling, the
 * runtime must durably claim this attempt, hold both locators and save its
 * write_started decision. There are no SQL/provider retries or cleanup here.
 * Successful EOF from both streams is required, including empty objects.
 * A lost PUT acknowledgement returns uncertainty without reading or writing
 * again; reconciliation is a separate, explicitly read-only operation below. */
export async function copyShadowBytes(storage: ShadowCopyStorage, input: ShadowCopyInput): Promise<ShadowCopyEvidence> {
  let writeMayHaveCommitted = false;
  try {
    const source = target(input.source);
    const destination = target(input.destination);
    const sourceReader = bindReader(storage.source, source.storage);
    const destinationReader = bindReader(storage.destination, destination.storage);
    const expected = expectation(input.expected, "source");
    const createHash = storage.createHash;
    const { contentType, filename } = input;
    if (typeof contentType !== "string" || typeof filename !== "string"
      || contentType.includes("\0") || filename.includes("\0")) {
      throw new ShadowByteTransferError("binding", "invalid_binding", false);
    }
    if (source.storage.namespaceIdentity === destination.storage.namespaceIdentity
      && source.objectKey === destination.objectKey) {
      throw new ShadowByteTransferError("binding", "same_location", false);
    }
    const accepts = storage.destination.writer.accepts;
    if (accepts !== "stream" && accepts !== "both") {
      throw new ShadowByteTransferError("binding", "unsupported_writer", false);
    }
    const write = storage.destination.writer.write.bind(storage.destination.writer);
    const body = await readBody(sourceReader, source.objectKey, "source");
    const verified = await writeVerifiedBytes({ reader: destinationReader, createHash, writer: {
      accepts,
      async write(request) {
        writeMayHaveCommitted = true;
        await write(request);
      },
    } }, { ...expected, key: destination.objectKey, body, contentType, filename });
    return Object.freeze({ kind: "copied", source: evidence(source, expected), destination: evidence(destination, verified) });
  } catch (error) {
    throw failure(error, writeMayHaveCommitted, writeMayHaveCommitted ? "destination" : "source");
  }
}

async function readEvidence(storage: ShadowReadStorage, input: ShadowReadInput): Promise<ShadowByteEvidence> {
  try {
    const location = target(input.target);
    const reader = bindReader(storage, location.storage);
    const expected = expectation(input.expected, "destination");
    const createHash = storage.createHash;
    const body = await readBody(reader, location.objectKey, "destination");
    return evidence(location, await verifyByteStream(body, expected, createHash, "destination"));
  } catch (error) {
    throw failure(error, false, "destination");
  }
}

/** Full read-only verification for adopting an existing location. This proves
 * bytes at the supplied locator, not publication, retention or an object lock. */
export async function verifyExistingShadowBytes(storage: ShadowReadStorage, input: ShadowReadInput): Promise<ShadowExistingEvidence> {
  return Object.freeze({ kind: "verified_existing", ...await readEvidence(storage, input) });
}

/** Only destination evidence. After uncertain PUT the runtime must also obtain
 * full source verification if it lacks source evidence for this attempt. This
 * operation cannot take write ownership, assert source proof or retry a PUT. */
export async function reconcileShadowDestination(storage: ShadowReadStorage, input: ShadowReadInput): Promise<ShadowReconciledEvidence> {
  return Object.freeze({ kind: "reconciled_destination", ...await readEvidence(storage, input) });
}
