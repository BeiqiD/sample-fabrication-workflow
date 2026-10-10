import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { searchReferencesReadOnly, type SearchReferencesOptions } from "./read-search";
export * from "./read-search";

/** Actual Worker read binding remains selected by the existing owner. */
export function searchReferences(db:D1Database,rawInput:unknown,options:SearchReferencesOptions={}) {
  return searchReferencesReadOnly(d1StorageConfigurationDatabase(db),rawInput,options);
}
