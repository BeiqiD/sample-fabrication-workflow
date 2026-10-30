import { ProjectServiceError } from "./errors";

export type SettlementProof = () => Promise<boolean>;

type ProjectFailure = {
  code: "not_found" | "conflict";
  message: string;
  authoritativeRejection: boolean;
};

function isDatabaseConflict(error: unknown) {
  return /(SQLITE_CONSTRAINT|constraint failed|UNIQUE constraint|FOREIGN KEY constraint|project item deletion requires|project item restore requires|project edge endpoints|reference target is unavailable|blob locator is unavailable|blob locator is quarantined)/i
    .test(String(error));
}

export async function classifyProjectFailure(
  error: unknown,
  settlementProof?: SettlementProof,
): Promise<ProjectFailure | null> {
  if (error instanceof ProjectServiceError) {
    if (error.code === "not_found") {
      return { code: "not_found", message: error.message, authoritativeRejection: false };
    }
    let authoritativeRejection = false;
    if (settlementProof) {
      try {
        authoritativeRejection = await settlementProof();
      } catch {
        // Settlement metadata is safety-only. Failure to prove an immutable
        // identity fence or a strictly advanced revision must remain uncertain.
        authoritativeRejection = false;
      }
    }
    return { code: "conflict", message: error.message, authoritativeRejection };
  }
  if (isDatabaseConflict(error)) {
    return {
      code: "conflict",
      message: "Project state changed before the operation could commit",
      authoritativeRejection: false,
    };
  }
  return null;
}
