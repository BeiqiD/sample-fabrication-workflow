import { d1FileBusinessMetadataDatabase } from "./business-metadata-d1";
import { fileAuthorityActiveSqlWithDatabase, deletedEventAssetSqlWithDatabase, deletedVerificationAssetSqlWithDatabase,
  deletedEventMetadataSqlWithDatabase, prepareFileRestorationWithDatabase, type RestoreKind } from "./business-lifecycle-service";

export async function fileAuthorityActiveSql(db: D1Database): Promise<"1" | "0"> {
  return fileAuthorityActiveSqlWithDatabase(d1FileBusinessMetadataDatabase(db));
}

export async function deletedEventAssetSql(db: D1Database) {
  return deletedEventAssetSqlWithDatabase(d1FileBusinessMetadataDatabase(db));
}

export async function deletedVerificationAssetSql(db: D1Database) {
  return deletedVerificationAssetSqlWithDatabase(d1FileBusinessMetadataDatabase(db));
}

export async function deletedEventMetadataSql(db: D1Database) {
  return deletedEventMetadataSqlWithDatabase(d1FileBusinessMetadataDatabase(db));
}

export async function prepareFileRestoration(db: D1Database, kind: RestoreKind, ids: string[]): Promise<D1PreparedStatement[]> {
  return prepareFileRestorationWithDatabase(d1FileBusinessMetadataDatabase(db), kind, ids);
}
