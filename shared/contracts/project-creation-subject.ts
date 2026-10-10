/** Request ownership only. This witness neither authenticates a request nor
 * grants Project access, membership, administrator or File permissions. */
export const PROJECT_CREATION_SUBJECT_HEADER = "x-sfw-project-creation-subject";
export const PROJECT_CREATION_SUBJECT_RESULT_HEADER = "x-sfw-project-creation-subject-result";
export interface ProjectCreationSubjectScope {
  authenticationFamily: "cloudflare-access" | "worker-development" | "node-local";
  installationContext: string;
}
export const isProjectCreationSubject = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export async function projectCreationSubject(actor: string, scope: ProjectCreationSubjectScope): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["sample-workflow/project-create-subject", 1,
    scope.authenticationFamily, scope.installationContext, actor]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
