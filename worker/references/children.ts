import type { ListReferenceChildrenResponse } from "../../shared/reference-children";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { listReferenceChildrenReadOnly } from "./read-children";
export * from "./read-children";

/** Genuine Worker compatibility owner; no local runtime constructs a D1 binding. */
export function listReferenceChildren(db: D1Database, rawInput: unknown): Promise<ListReferenceChildrenResponse> {
  return listReferenceChildrenReadOnly(d1StorageConfigurationDatabase(db),rawInput);
}
