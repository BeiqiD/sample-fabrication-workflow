import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { readFileAuthorityMode } from "./authority-reader";

/** Restored canonical authority is not permission to run the source's jobs. */
export async function ensureFileAuthorityExecution(database: D1Database): Promise<void> {
  if (await readFileAuthorityMode(database) !== "active") return;
  const row = await primaryD1(database).prepare("SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1")
    .first<{ enabled: number }>();
  if (row?.enabled !== 1) {
    throw new HTTPException(503, { message: "File execution is paused on this installation. An operator must enable it after recovery." });
  }
}

export const fileAuthorityExecutionAdmission: MiddlewareHandler<{ Bindings: Env; Variables: { userEmail: string } }> = async (c, next) => {
  // File administration and read-only export use their own admission. Paused
  // recovery keeps authenticated reads and the explicit repair controls usable.
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method) || c.req.path.startsWith("/api/files/")
    || c.req.path.startsWith("/api/export/")) return next();

  // Route input validation runs first. The first actual database execution
  // admits the request once, before any business query or mutation can run.
  // Use the original binding for admission to avoid recursing through its gate.
  const original = c.env.DB;
  let admission: Promise<void> | undefined;
  let admissionFailure: unknown;
  const admit = () => admission ??= ensureFileAuthorityExecution(original).catch(error => {
    admissionFailure = error;
    throw error;
  });
  const originals = new WeakMap<object, object>();
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "bind") return (...args: unknown[]) => wrapStatement(Reflect.apply(value, target, args));
        if (["first", "all", "run", "raw"].includes(String(property))) return async (...args: unknown[]) => {
          await admit();
          return Reflect.apply(value, target, args);
        };
        return value.bind(target);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const wrapDatabase = (database: D1Database): D1Database => new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "prepare") return (...args: unknown[]) => wrapStatement(Reflect.apply(value, target, args));
      if (property === "withSession") return (...args: unknown[]) => wrapDatabase(Reflect.apply(value, target, args));
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        await admit();
        return Reflect.apply(value, target, [statements.map(statement => originals.get(statement) ?? statement)]);
      };
      if (property === "exec") return async (...args: unknown[]) => {
        await admit();
        return Reflect.apply(value, target, args);
      };
      return value.bind(target);
    },
  });
  // Context owns this clone; concurrent requests keep the original Env binding.
  c.env = { ...c.env, DB: wrapDatabase(original) };
  await next();
  // Some business services deliberately translate database exceptions. Keep
  // the installation pause visible even when such a service catches this one.
  if (admissionFailure instanceof HTTPException) c.res = c.json({ error: admissionFailure.message }, admissionFailure.status);
};
