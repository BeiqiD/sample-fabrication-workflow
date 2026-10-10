import type { ReadSqlDatabase } from "../runtime/read-sql";
import type { ReferenceTarget, ResolveReferencesResponse } from "../../shared/reference-types";
import type { ListReferenceChildrenResponse } from "../../shared/reference-children";
import type { SearchReferencesResponse } from "../../shared/reference-search";
import { resolveReferencesReadOnly } from "./read-resolver";
import { listReferenceChildrenReadOnly, normalizeReferenceChildrenInput } from "./read-children";
import { searchNormalizedReferencesReadOnly, normalizeReferenceSearchInput } from "./read-search";

export interface ReferenceReadService {
  resolve(targets: readonly ReferenceTarget[], actor: string): Promise<ResolveReferencesResponse>;
  children(input: unknown, actor: string): Promise<ListReferenceChildrenResponse>;
  search(input: unknown, actor: string): Promise<SearchReferencesResponse>;
}
/** Runtime owns current authentication/maintenance admission. This library
 * reads existing reference metadata only: no registration, File/media bytes,
 * provider port, ownership grants or full Node application activation. */
export function createReferenceReadService(options: {
  database(): ReadSqlDatabase;
  admit(actor: string): Promise<void>;
}): ReferenceReadService {
  const { database, admit } = options;
  async function read<T>(actor: string, work: (sql: ReadSqlDatabase) => Promise<T>) {
    await admit(actor); const result = await work(database()); await admit(actor); return result;
  }
  return Object.freeze({
    resolve(targets: readonly ReferenceTarget[], actor: string) {
      const captured = targets.map(({type,id}) => ({type,id}));
      return read(actor, async sql => ({results:await resolveReferencesReadOnly(sql,captured)}));
    },
    children(input: unknown, actor: string) {
      const normalized = normalizeReferenceChildrenInput(input);
      const captured = {parent:{...normalized.parent},limit:normalized.limit};
      return read(actor, sql => listReferenceChildrenReadOnly(sql,captured));
    },
    search(input: unknown, actor: string) {
      const captured = normalizeReferenceSearchInput(input);
      return read(actor, sql => searchNormalizedReferencesReadOnly(sql,captured));
    },
  });
}
