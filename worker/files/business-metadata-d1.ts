import { primaryD1 } from "../d1-primary";
import { readFileAuthorityMode } from "./authority-reader";
import type { FileBusinessMetadataDatabase } from "./business-metadata-sql";

/** Actual Worker D1 binding and its original primary/mode behavior. Native
 * runtimes never create an Env/D1 facade or borrow this adapter. */
export function d1FileBusinessMetadataDatabase(database: D1Database): FileBusinessMetadataDatabase<D1PreparedStatement> {
  return {
    prepare(sql) { return database.prepare(sql); },
    primary() { return d1FileBusinessMetadataDatabase(primaryD1(database)); },
    authorityMode() { return readFileAuthorityMode(database); },
  };
}
