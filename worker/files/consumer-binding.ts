import { d1FileBusinessMetadataDatabase } from "./business-metadata-d1";
import { resolveConsumerFileIdWithDatabase, consumerFileBindingFenceWithDatabase, type ConsumerFileInput } from "./consumer-binding-service";
export type { ConsumerFileInput } from "./consumer-binding-service";

export async function resolveConsumerFileId(db: D1Database, input: ConsumerFileInput): Promise<string | null> {
  return resolveConsumerFileIdWithDatabase(d1FileBusinessMetadataDatabase(db), input);
}
export function consumerFileBindingFence(db: D1Database, input: ConsumerFileInput, fileId: string | null): D1PreparedStatement {
  return consumerFileBindingFenceWithDatabase(d1FileBusinessMetadataDatabase(db), input, fileId);
}
