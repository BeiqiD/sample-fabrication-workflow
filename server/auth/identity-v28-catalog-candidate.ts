// SOURCE-ONLY exact forward identity extension; old prototype/v1 admission is frozen.
import { createHash } from "node:crypto";
import type { SqliteCapability } from "../sqlite";
import { PROTOTYPE_IDENTITY_STATEMENTS } from "./identity-catalog.ts";
import { LOCAL_AUTH_EVENTS_DDL_V28 } from "../../shared/contracts/local-identity-v28-extension.ts";
const statements = Object.freeze(PROTOTYPE_IDENTITY_STATEMENTS.map(sql => sql.startsWith("CREATE TABLE local_auth_events (") ? LOCAL_AUTH_EVENTS_DDL_V28 : sql));
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const expected = createHash("sha256").update(statements.map(normalize).sort().join("\n")).digest("hex");
export async function assertExactLocalIdentityV28CandidateObjects(database: SqliteCapability): Promise<void> {
  const rows = (await database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name IN ('local_identity_installation','local_accounts','local_admin_grants','local_sessions','local_sessions_principal','local_login_throttle','local_auth_events') ORDER BY name").all()).results;
  if (rows.length !== statements.length || rows.some(row => typeof row.sql !== "string")) throw new Error("Local identity catalog does not match");
  const digest = createHash("sha256").update(rows.map(row => normalize(row.sql as string)).sort().join("\n")).digest("hex");
  if (digest !== expected) throw new Error("Local identity catalog does not match");
}
