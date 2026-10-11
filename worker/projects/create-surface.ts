import { type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { PROJECT_CREATION_SUBJECT_HEADER, PROJECT_CREATION_SUBJECT_RESULT_HEADER, isProjectCreationSubject } from "../../shared/project-creation-subject";
import { classifyProjectFailure } from "./failure";
import type { ProjectCreationService } from "./create-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** New Node owner only. The mature Worker route is unchanged in this slice.
 * Mount capture and subject check before any raw-body substitution or JSON. */
export function createProjectCreationHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings) => ProjectCreationService,
  currentSubject: (request: Request, bindings: Bindings, actor: string) => Promise<string>,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const ingressRequest = (c: Context<ActorBindings<Bindings>>) => {
    const request = requests.get(c); if (!request) throw new Error("Project request admission is unavailable"); return request;
  };
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  const admitCreationSubject: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    const expected = c.req.header(PROJECT_CREATION_SUBJECT_HEADER);
    if (!isProjectCreationSubject(expected) || expected !== await currentSubject(ingressRequest(c), c.env, c.get("userEmail"))) {
      c.header(PROJECT_CREATION_SUBJECT_RESULT_HEADER, "mismatch");
      throw new HTTPException(409, { message: "Sign-in identity changed. Refresh Projects before retrying." });
    }
    await next();
  };
  return {
    captureIngressRequest, admitCreationSubject,
    async create(c: Context<ActorBindings<Bindings>>) {
      let value: unknown;
      try { value = await c.req.json<unknown>(); }
      catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
      try {
        const result = await selectService(ingressRequest(c), c.env).create(value, c.get("userEmail"));
        return c.json(result, result.replayed ? 200 : 201);
      } catch (error) {
        const failure = await classifyProjectFailure(error);
        if (failure) throw new HTTPException(failure.code === "not_found" ? 404 : 409, { message: failure.message });
        throw error;
      }
    },
  };
}
