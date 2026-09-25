import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { openShadowProfile } from "./shadow-profile";

const namespace = JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "file-shadow-test" });
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture(recordedNamespace = namespace) {
  const sql = referenceTestDatabase({ throughMigration: "0007_fp1_file_authority_transition.sql" });
  databases.push(sql);
  sql.prepare(`INSERT INTO storage_profiles VALUES ('bound-r2','r2',?,'bootstrap',NULL,1,'historical','2026-09-25T00:00:00.000Z')`).run(recordedNamespace);
  const get = vi.fn(async () => null);
  const put = vi.fn(async () => { throw new Error("Unexpected write"); });
  const env = { DB: new SqliteD1Database(sql), ASSETS: { get, head: get, put }, R2_BOOTSTRAP_NAMESPACE: namespace } as unknown as Env;
  return { env, get, put };
}
describe("exact File shadow profile binding", () => {
  it("binds the recorded namespace without provider I/O, registration or default selection", async () => {
    const { env, get, put } = fixture();
    const bound = await openShadowProfile(env, { profileId: "bound-r2", configurationRevision: 1 }, "read");
    expect(bound.storage).toEqual({ profileId: "bound-r2", configurationRevision: 1, adapterType: "r2", namespaceIdentity: namespace });
    expect(bound.writer).toBeUndefined();
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(await bound.reader.read("exact-key")).toEqual({ outcome: "missing" });
    expect(get).toHaveBeenCalledExactlyOnceWith("exact-key");
  });
  it("does not infer access from a matching profile ID or adapter label", async () => {
    const other = JSON.stringify({ kind: "cloudflare-r2", accountId: "b".repeat(32), bucketName: "file-shadow-test" });
    const { env, get, put } = fixture(other);
    await expect(openShadowProfile(env, { profileId: "bound-r2", configurationRevision: 1 }, "read")).rejects.toThrow("recorded File storage profile is unavailable");
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
  it("rejects missing/revised identities and read-only destinations before transport", async () => {
    const { env, get, put } = fixture();
    for (const frozen of [{ profileId: "missing", configurationRevision: 1 }, { profileId: "bound-r2", configurationRevision: 2 }]) {
      await expect(openShadowProfile(env, frozen, "read")).rejects.toThrow("profile is unavailable");
    }
    await expect(openShadowProfile(env, { profileId: "bound-r2", configurationRevision: 1 }, "write")).rejects.toThrow("profile is unavailable");
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
});
