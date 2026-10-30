import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_CREATION_SUBJECT_HEADER, PROJECT_CREATION_SUBJECT_RESULT_HEADER, projectCreationSubject } from "../shared/project-creation-subject";
import { routes as projectRoutes } from "./project-routes";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { workerProjectCreationSubjectScope } from "./projects/creation-subject";
import type { Env } from "./types";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = referenceTestDatabase(); databases.push(database);
  const adapter = new SqliteD1Database(database);
  const env = { DB: adapter as unknown as D1Database, AUTH_MODE: "disabled",
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "local-r2", installationId: "10000000-0000-4000-8000-000000000001", bucketName: "subject-fixture" }) } as Env;
  // Controlled trusted middleware actors; this route/SQL fixture does not claim
  // Cloudflare Access signing, local login or small-group authorization.
  let actor = "controlled-actor-a";
  const app = new Hono<Bindings>();
  app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
  app.onError((error, c) => { if (error instanceof HTTPException) return c.json({ error: error.message }, error.status); throw error; });
  app.route("/", projectRoutes);
  const request = (method: "GET" | "POST", input?: unknown, subject?: string) => app.request("http://127.0.0.1/projects", {
    method, headers: { "content-type": "application/json", ...(subject === undefined ? {} : { [PROJECT_CREATION_SUBJECT_HEADER]: subject }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }, env);
  return { database, adapter, env, request, actor: (value: string) => { actor = value; } };
}

describe("Project creation expected-subject ownership", () => {
  it("issues a read-only, purpose/auth-family/installation/actor scoped witness without changing the directory body", async () => {
    const f = fixture(), response = await f.request("GET"), witness = response.headers.get(PROJECT_CREATION_SUBJECT_HEADER);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ projects: [] });
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(witness).toMatch(/^[a-f0-9]{64}$/);
    const request = new Request("http://127.0.0.1/projects"), scope = workerProjectCreationSubjectScope(request, f.env);
    expect(witness).toBe(await projectCreationSubject("controlled-actor-a", scope));
    expect(await projectCreationSubject("controlled-actor-b", scope)).not.toBe(witness);
    expect(await projectCreationSubject("controlled-actor-a", { ...scope, authenticationFamily: "node-local" })).not.toBe(witness);
    expect(await projectCreationSubject("controlled-actor-a", { ...scope, installationContext: "different-installation" })).not.toBe(witness);
    expect(f.database.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 0 });
  });

  it("rejects a changed genuine middleware actor and malformed expected witnesses before any Project service SQL", async () => {
    const f = fixture(), first = await f.request("GET"), subject = first.headers.get(PROJECT_CREATION_SUBJECT_HEADER)!;
    const prepare = vi.spyOn(f.adapter, "prepare"), input = { id: "owned-project", title: "Original title", operationId: "owned-operation" };
    f.actor("controlled-actor-b"); prepare.mockClear();
    const changed = await f.request("POST", input, subject);
    expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: "Sign-in identity changed. Refresh Projects before retrying." });
    expect(changed.headers.get(PROJECT_CREATION_SUBJECT_RESULT_HEADER)).toBe("mismatch");
    expect(prepare).not.toHaveBeenCalled();
    const malformed = await f.request("POST", input, "not-an-authority"); expect(malformed.status).toBe(409);
    expect(prepare).not.toHaveBeenCalled(); expect(f.database.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 0 });
  });

  it("preserves one accepted Project and its exact replay while optional-header legacy clients remain compatible", async () => {
    const f = fixture(), subject = (await f.request("GET")).headers.get(PROJECT_CREATION_SUBJECT_HEADER)!;
    const input = { id: "accepted-project", title: "Preserved research", operationId: "accepted-operation" };
    const original = await f.request("POST", input, subject); expect(original.status).toBe(201);
    const originalBody = await original.json();
    if (typeof originalBody !== "object" || originalBody === null || Array.isArray(originalBody)) {
      throw new Error("The accepted Project receipt must be a JSON object.");
    }
    const replay = await f.request("POST", input, subject); expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...originalBody, replayed: true });
    f.actor("controlled-actor-b"); expect((await f.request("POST", input, subject)).status).toBe(409);
    expect(f.database.prepare("SELECT id,title,last_mutation_id,created_by,revision FROM projects").all()).toEqual([
      { id: input.id, title: input.title, last_mutation_id: input.operationId, created_by: "controlled-actor-a", revision: 1 },
    ]);
    const legacy = await f.request("POST", { id: "legacy-project", title: "Legacy client", operationId: "legacy-operation" });
    expect(legacy.status).toBe(201); expect(f.database.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 2 });
  });
});
