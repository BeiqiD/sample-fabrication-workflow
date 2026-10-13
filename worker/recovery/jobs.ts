import type { RecoveryClaim, RecoveryJob, SystemRecoveryRepository } from "./repository";
import type { Sha256Factory } from "../files/byte-verification";
export { runBoundedSystemRecoveryReadAction, runSystemRecoveryJobStep, writeSystemRecoveryUpload } from "./kernel";

export interface RecoveryStepResult {
  patch: Partial<RecoveryJob>; statements?: readonly D1PreparedStatement[]; outcome: string;
}
export interface SystemRecoveryCapabilitiesAdapter {
  repository: SystemRecoveryRepository; incarnation: string; authorizeActor(actor: string): boolean;
  now(): Date; randomId(): string; hash: Sha256Factory;
  step(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<RecoveryStepResult>;
  exportBody(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  put(key: string, body: ReadableStream<Uint8Array>, byteSize: number): Promise<void>;
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
}
