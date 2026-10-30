import type { ExportSchemaObject } from "../../shared/contracts/export";
import { checkedPortableApplicationSchema } from "../../shared/contracts/export-portable-runtime";
import { stripReviewedCurrentCloudflarePlatformSchema, type CurrentCloudflareSchemaInspection } from "../../shared/contracts/cloudflare-platform-schema";
export { stripReviewedCurrentCloudflarePlatformSchema } from "../../shared/contracts/cloudflare-platform-schema";
export type { CurrentCloudflareSchemaInspection } from "../../shared/contracts/cloudflare-platform-schema";

/** Exact platform admission followed by the full code-owned current application
 * pin. There is no allowEmpty/allowExtra mode. Historical readers are unchanged. */
export async function inspectCurrentCloudflareSchema(values: readonly ExportSchemaObject[]): Promise<CurrentCloudflareSchemaInspection> {
  const { applicationObjects, ledgerPresent } = stripReviewedCurrentCloudflarePlatformSchema(values);
  // All primitive fields were copied before this asynchronous application pin
  // check. Mutating the caller's inventory cannot retarget the admitted tuple.
  return { applicationObjects: await checkedPortableApplicationSchema(applicationObjects), ledgerPresent };
}
