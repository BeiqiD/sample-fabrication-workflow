#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one replacement target, found {count}")
    path.write_text(text.replace(old, new, 1))


index_path = ROOT / "worker/index.ts"
replace_once(
    index_path,
    '''    } catch (error) {
      let winner;
      try {
        winner = await reusableR2Asset(c.env, sha256);
      } catch (verificationError) {
        await c.env.ASSETS.delete(key);
        throw verificationError;
      }
      if (winner) {
        await c.env.ASSETS.delete(key);
        return c.json({ id: winner.id, key: winner.r2_key, deduplicated: true });
      }
      await c.env.ASSETS.delete(key);
      if (attempt === 1) throw error;
    }
''',
    '''    } catch (error) {
      // The INSERT may have committed even when D1 lost the response. Reconcile
      // the exact stable ID/key on the primary before treating another row as a
      // deduplication winner or deleting the uploaded provider object.
      const committed = await primaryD1(c.env.DB).prepare(`
        SELECT a.id, a.r2_key
        FROM assets a
        WHERE a.id = ? AND a.r2_key = ? AND a.sha256 = ?
          AND a.status = 'ready' AND a.import_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM blob_integrity_quarantine biq
            WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
              AND biq.object_key = a.r2_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM blob_gc_ledger bg
            WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
              AND bg.object_key = a.r2_key
              AND bg.state IN ('deleting', 'deleted')
          )
      `).bind(id, key, sha256).first<{ id: string; r2_key: string }>();
      if (committed) {
        return c.json({
          id: committed.id,
          key: committed.r2_key,
          deduplicated: false,
        }, 201);
      }

      let winner;
      try {
        winner = await reusableR2Asset(c.env, sha256);
      } catch (verificationError) {
        await c.env.ASSETS.delete(key);
        throw verificationError;
      }
      if (winner) {
        await c.env.ASSETS.delete(key);
        return c.json({ id: winner.id, key: winner.r2_key, deduplicated: true });
      }
      await c.env.ASSETS.delete(key);
      if (attempt === 1) throw error;
    }
''',
)

route_path = ROOT / "worker/blob-integrity-routes.test.ts"
replace_once(
    route_path,
    '''    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
''',
    '''    const result = statement.run(...this.bindings);
    const response = {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
    this.owner.afterExecute?.(this.sql, this.bindings, response);
    return response;
''',
)
replace_once(
    route_path,
    '''    readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
    readonly beforeBatch?: (statements: HookedD1Statement[]) => Promise<void> | void,
    readonly afterBatch?: (statements: HookedD1Statement[]) => Promise<void> | void,
  ) {}
''',
    '''    readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
    readonly beforeBatch?: (statements: HookedD1Statement[]) => Promise<void> | void,
    readonly afterBatch?: (statements: HookedD1Statement[]) => Promise<void> | void,
    readonly afterExecute?: (
      query: string,
      bindings: unknown[],
      response: { success: boolean; results: unknown[]; meta: { changes: number } },
    ) => void,
  ) {}
''',
)
route_text = route_path.read_text()
if "keeps its own committed upload when the D1 INSERT response is lost" not in route_text:
    route_path.write_text(route_text.rstrip() + '''

describe("ordinary asset registration reconciliation", () => {
  it("keeps its own committed upload when the D1 INSERT response is lost", async () => {
    const database = referenceTestDatabase();
    const bytes = Uint8Array.from([137, 80, 78, 71, 21, 22, 23, 24]);
    const stored = new Map<string, Uint8Array>();
    const deletedKeys: string[] = [];
    let lostResponseInjected = false;
    const d1 = new HookedD1Database(
      database,
      undefined,
      undefined,
      undefined,
      (query) => {
        if (!lostResponseInjected
          && query.includes("INSERT INTO assets (id, r2_key")) {
          lostResponseInjected = true;
          throw new Error("injected committed asset INSERT response loss");
        }
      },
    );
    const put = vi.fn(async (key: string, value: unknown) => {
      if (!(value instanceof ArrayBuffer)) {
        throw new Error("Expected an ArrayBuffer upload");
      }
      stored.set(key, new Uint8Array(value.slice(0)));
    });
    const remove = vi.fn(async (key: string) => {
      deletedKeys.push(key);
      stored.delete(key);
    });
    const head = vi.fn(async (key: string) => {
      const value = stored.get(key);
      return value ? r2Object(value, "image/png") : null;
    });
    const get = vi.fn(async (key: string) => {
      const value = stored.get(key);
      return value ? r2Object(value, "image/png") : null;
    });
    const env = {
      AUTH_MODE: "disabled",
      DB: d1 as unknown as D1Database,
      ASSETS: {
        put,
        delete: remove,
        head,
        get,
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;

    const response = await worker.fetch(new Request(
      "https://app.test/api/assets",
      {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-filename": "committed.png",
        },
        body: bytes,
      },
    ), env, executionContext);
    expect(response.status).toBe(201);
    const registered = await response.json() as {
      id: string;
      key: string;
      deduplicated: boolean;
    };
    expect(registered.deduplicated).toBe(false);
    expect(lostResponseInjected).toBe(true);
    expect(deletedKeys).not.toContain(registered.key);
    expect(stored.get(registered.key)).toEqual(bytes);
    expect(database.prepare(`
      SELECT id, r2_key, status
      FROM assets WHERE id = ?
    `).get(registered.id)).toEqual({
      id: registered.id,
      r2_key: registered.key,
      status: "ready",
    });

    const live = await worker.fetch(new Request(
      `https://app.test/api/assets/${registered.key}`,
    ), env, executionContext);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(bytes);
    database.close();
  });
});
''')

migration_test_path = ROOT / "worker/blob-lifecycle-migration-safety.test.ts"
migration_test_text = migration_test_path.read_text()
if "function migrationRecoveryEnv" not in migration_test_text:
    marker = '\n\ndescribe("blob lifecycle migration safety", () => {'
    if marker not in migration_test_text:
        raise RuntimeError("migration safety describe marker missing")
    helper = '''

function migrationRecoveryEnv(database: DatabaseSync) {
  const head = async (key: string) => {
    const row = database.prepare(`
      SELECT byte_size FROM assets WHERE r2_key = ?
    `).get(key) as { byte_size: number } | undefined;
    if (!row) return null;
    return {
      size: Number(row.byte_size),
      httpEtag: '\"migration-recovery\"',
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", "application/octet-stream");
      },
    };
  };
  return {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {
      head,
      get: async () => null,
      delete: async () => undefined,
      put: async () => undefined,
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket,
  } satisfies Env;
}
'''
    migration_test_text = migration_test_text.replace(marker, helper + marker, 1)
migration_test_text = migration_test_text.replace(
    '''    expect(() => database.exec(readFileSync(
      new URL("0025_fabublox_publication_boundaries.sql", migrationDirectory),
      "utf8",
    ))).not.toThrow();
''',
    '''    expect(() => applyMigrations(
      database,
      (name) => name > "0024_blob_integrity_quarantine.sql",
    )).not.toThrow();
''',
)
migration_test_text = migration_test_text.replace(
    "const env = { DB: new SqliteD1Database(database) } as unknown as Env;",
    "const env = migrationRecoveryEnv(database);",
)
migration_test_path.write_text(migration_test_text)

appenditions = [
    (
        ROOT / "docs/BLOB_LIFECYCLE_CONTRACT.md",
        "## Recovery publication and ownership boundary",
        '''

## Recovery publication and ownership boundary

`blob_retention_edges` answers only whether a physical locator must be retained. It is not an authorization or publication surface. FabuBlox recovery uses the dedicated `fabublox_recovery_public_asset_edges` and `fabublox_recovery_import_asset_edges` projections installed by `0026_fabublox_recovery_ownership.sql`.

For an asset whose owning import becomes terminal:

- an independently public consumer permits provider-verified re-homing as a standalone `ready` asset;
- an unresolved pending import inherits ownership and the asset remains `pending` and non-public;
- an unresolved failed import may inherit terminal ownership so its later recovery remains responsible for cleanup;
- no viable consumer releases the asset to `failed` and operation-ID GC;
- a missing or size-mismatched provider object is quarantined and never promoted solely because a retention edge exists.

R2 verification occurs before the durable recovery claim. A transient provider failure therefore leaves `recovery_operation_id` unset and the whole operation retryable. A legacy `failed` asset whose SHA was cleared is read from R2, re-hashed, and assigned the provider byte size before any transition to `pending` or `ready`.
''',
    ),
    (
        ROOT / "docs/BLOB_LIFECYCLE_OPERATIONS.md",
        "## FabuBlox recovery diagnostics",
        '''

## FabuBlox recovery diagnostics

Recovery now separates three signals:

1. `blob_retention_edges` prevents physical deletion;
2. `fabublox_recovery_public_asset_edges` permits public standalone ownership;
3. `fabublox_recovery_import_asset_edges` identifies the next unresolved private owner.

A provider outage increments `staleImportRecoveryFailures` without claiming the import. Definite absence or size mismatch writes `blob_integrity_quarantine`; live delivery remains blocked while export retains the warning and historical metadata. A pending successor that inherits an unavailable asset cannot finalize because `imports_require_publishable_assets` rejects the transition to `ready`.
''',
    ),
    (
        ROOT / "docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md",
        "## 0026 recovery ownership projection",
        '''

## 0026 recovery ownership projection

`0026_fabublox_recovery_ownership.sql` deliberately leaves the generic GC view unchanged and adds recovery-only projections for publication and private ownership succession. Recovery performs provider preflight before claiming the import, then atomically cleans failed-import provenance, repairs legacy metadata, transfers private ownership when necessary, and queues only genuinely unowned locators.

Ordinary `/assets` registration uses the same exact-outcome principle: after an uncertain INSERT response it first reconciles its stable `id` and R2 key on the primary database. It deletes the uploaded key only after proving that a different canonical winner committed.
''',
    ),
]
for path, marker, addition in appenditions:
    text = path.read_text()
    if marker not in text:
        path.write_text(text.rstrip() + addition)

for temporary in [
    ROOT / ".github/apply-pr141-existing-files.py",
    ROOT / ".github/workflows/apply-pr141-existing-files.yml",
]:
    temporary.unlink(missing_ok=True)
