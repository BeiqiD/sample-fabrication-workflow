import type { ExportSchemaObject } from "../../shared/contracts/export";
import { checkedPortableApplicationSchemaV26 } from "../../shared/contracts/export-portable-runtime-v26";
import { stripReviewedCurrentCloudflarePlatformSchema, type CurrentCloudflareSchemaInspection } from "./current-cloudflare-schema";
/** The platform inventory is unchanged; application admission is separately V26. */
export async function inspectV26CloudflareSchema(values: readonly ExportSchemaObject[]): Promise<CurrentCloudflareSchemaInspection> {
  const { applicationObjects, ledgerPresent } = stripReviewedCurrentCloudflarePlatformSchema(values);
  return { applicationObjects: await checkedPortableApplicationSchemaV26(applicationObjects), ledgerPresent };
}
export { stripReviewedCurrentCloudflarePlatformSchema } from "./current-cloudflare-schema";
