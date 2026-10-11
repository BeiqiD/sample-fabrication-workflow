import { HTTPException } from "hono/http-exception";
import type { ReadSqlDatabase } from "../runtime/read-sql";
import { readSqlFileAuthorityMode } from "./authority-mode";

export async function ensureSqlFileAuthorityExecution(selectDatabase: () => ReadSqlDatabase): Promise<void> {
  if (await readSqlFileAuthorityMode(selectDatabase) !== "active") return;
  const row = await selectDatabase().prepare("SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1")
    .first();
  if (row?.enabled !== 1) {
    throw new HTTPException(503, { message: "File execution is paused on this installation. An operator must enable it after recovery." });
  }
}
