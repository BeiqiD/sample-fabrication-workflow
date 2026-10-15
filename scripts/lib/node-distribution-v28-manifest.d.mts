export const distributionVersion: 3;
export const distributionNodeVersion: "24.19.0";
export const distributionInstallationCheckpoint: Readonly<{ id: "portable-runtime/v26"; migrationCount: 24 }>;
export const distributionOfflineRecoveryCheckpoint: Readonly<{ id: "portable-runtime/v28"; migrationCount: 26; archiveFormat: "v5"; executionEnabled: false }>;
export function verifyNodeDistribution(root: string, options?: { enforceRuntimeVersion?: boolean }): Promise<Readonly<{
  format: string; version: number; nodeVersion: string; capabilityScope: string;
  installationCheckpoint: typeof distributionInstallationCheckpoint;
  offlineRecoveryCheckpoint: typeof distributionOfflineRecoveryCheckpoint;
  files: number; bytes: number; sourceInputs: number; manifestSha256: string;
}>>;
