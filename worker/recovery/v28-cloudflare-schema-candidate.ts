// Explicit SOURCE-only V28 application admission; historical platform/default checks stay unchanged.
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { checkedPortableApplicationSchemaV28 } from "../../shared/contracts/export-portable-runtime-v28";
import { stripReviewedCurrentCloudflarePlatformSchema, type CurrentCloudflareSchemaInspection } from "./current-cloudflare-schema";

/** Admit the entire reviewed Cloudflare platform inventory before the separate
 * exact V28 application pin. An empty target is handled by its constructor's
 * platform-only inspection, never an allowEmpty bypass of this checker. */
export async function inspectV28CloudflareSchemaCandidate(values: readonly ExportSchemaObject[]): Promise<CurrentCloudflareSchemaInspection> {
  const { applicationObjects, ledgerPresent } = stripReviewedCurrentCloudflarePlatformSchema(values);
  return { applicationObjects: await checkedPortableApplicationSchemaV28(applicationObjects), ledgerPresent };
}
