from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


Path("worker/blob-integrity-routes.test.ts").write_text(r'''import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import { encodeReferenceRouteId } from "../shared/reference-destinations";
import worker from "./index";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";
import type { Env } from "./types";

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const NOW = "2026-08-14T18:00:00.000Z";

function streamBytes(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function r2Object(bytes: Uint8Array, contentType = "application/octet-stream") {
  return {
    body: streamBytes(bytes),
    size: bytes.byteLength,
    httpEtag: '"integrity-etag"',
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

class HookedD1Statement {
  constructor(
    private readonly owner: HookedD1Database,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new HookedD1Statement(this.owner, this.sql, bindings);
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.sql);
  }

  async first<T>() {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.bindings) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    return this.execute();
  }

  execute() {
    this.owner.beforeExecute?.(this.sql, this.bindings);
    const statement = this.statement();
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return { success: true, results: statement.all(...this.bindings), meta: { changes: 0 } };
    }
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class HookedD1Database {
  constructor(
    readonly database: DatabaseSync,
    readonly beforeExecute?: (query: string, bindings: unknown[]) => void,
  ) {}

  prepare(sql: string) {
    return new HookedD1Statement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as unknown as HookedD1Statement).execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("quarantine-aware live delivery", () => {
  it("blocks quarantined R2 assets from ordinary and execution-image routes while export remains readable", async () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES ('r2', 'r2', 'reference/private/execution.png',
        'reference-execution-asset', 'size_mismatch', 11, 99,
        'operation-live-r2', ?, ?)
    `).run(NOW, NOW);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const get = vi.fn(async (key: string) =>
      key === "reference/private/execution.png" ? r2Object(bytes, "image/png") : null);
    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: { get } as unknown as R2Bucket,
    } satisfies Env;

    const ordinary = await worker.fetch(new Request(
      "https://app.test/api/assets/reference/private/execution.png",
    ), env, executionContext);
    const execution = await worker.fetch(new Request(
      `https://app.test/api/references/media/execution_image/${encodeReferenceRouteId(REFERENCE_FIXTURE_IDS.executionImage)}?step=${REFERENCE_FIXTURE_IDS.stepA}`,
    ), env, executionContext);
    expect(ordinary.status).toBe(404);
    expect(execution.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    const exported = await worker.fetch(new Request(
      "https://app.test/api/exports/r2/reference/private/execution.png",
    ), env, executionContext);
    expect(exported.status).toBe(200);
    expect(new Uint8Array(await exported.arrayBuffer())).toEqual(bytes);
    expect(get).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("blocks a quarantined managed Comment attachment from live download while export still reads it", async () => {
    const database = referenceTestDatabase();
    database.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('sample-managed-live', 'M-LIVE', 'Managed live sample', '${NOW}', '${NOW}');
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES (
        'managed-live-object', 'switchdrive', 'comments/live/file.bin', 'file.bin',
        'application/octet-stream', 9,
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        'ready', 'user@example.com', '${NOW}'
      );
      INSERT INTO comment_submissions (
        id, context_kind, sample_id, body, status, actor_email,
        created_at, updated_at, completed_at
      ) VALUES (
        'managed-live-submission', 'sample', 'sample-managed-live', 'Attachment',
        'ready', 'user@example.com', '${NOW}', '${NOW}', '${NOW}'
      );
      INSERT INTO comment_submission_items (
        id, submission_id, kind, status, position, filename, mime_type,
        byte_size, storage_object_id, created_at, updated_at
      ) VALUES (
        'managed-live-item', 'managed-live-submission', 'attachment', 'ready', 0,
        'file.bin', 'application/octet-stream', 9, 'managed-live-object',
        '${NOW}', '${NOW}'
      );
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES (
        'managed', 'switchdrive', 'comments/live/file.bin', 'managed-live-object',
        'size_mismatch', 9, 12, 'operation-live-managed', '${NOW}', '${NOW}'
      );
    `);
    const bytes = Uint8Array.from([9, 8, 7]);
    const fetchMock = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        etag: '"managed-live"',
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      AUTH_MODE: "disabled",
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: {} as R2Bucket,
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
      SWITCHDRIVE_USERNAME: "user@example.ch",
      SWITCHDRIVE_APP_PASSWORD: "app-password",
    } satisfies Env;

    const live = await worker.fetch(new Request(
      "https://app.test/api/attachments/managed-live-item/download",
    ), env, executionContext);
    expect(live.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();

    const exported = await worker.fetch(new Request(
      "https://app.test/api/exports/attachments/managed-live-item",
    ), env, executionContext);
    expect(exported.status).toBe(200);
    expect(new Uint8Array(await exported.arrayBuffer())).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    database.close();
  });
});

describe("FabuBlox storage winner recovery", () => {
  it("reconciles a valid winner inserted after initial verification and before asset registration", async () => {
    const database = referenceTestDatabase();
    const workbookBytes = Uint8Array.from([80, 75, 3, 4, 20, 26, 8, 0]);
    const workbookBuffer = workbookBytes.buffer.slice(
      workbookBytes.byteOffset,
      workbookBytes.byteOffset + workbookBytes.byteLength,
    ) as ArrayBuffer;
    const workbookSha = await sha256Hex(workbookBuffer);
    const winnerKey = "race/winner.xlsx";
    const stored = new Map<string, Uint8Array>([[winnerKey, workbookBytes]]);
    const deletedKeys: string[] = [];
    let injected = false;
    const d1 = new HookedD1Database(database, (query, bindings) => {
      if (injected || !/^\s*INSERT INTO assets\b/i.test(query)
        || bindings.at(-1) !== workbookSha) return;
      injected = true;
      database.prepare(`
        INSERT INTO assets (
          id, r2_key, original_name, mime_type, byte_size,
          status, actor_email, created_at, sha256
        ) VALUES (
          'fabublox-race-winner', ?, 'race.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ?,
          'ready', 'winner@example.com', ?, ?
        )
      `).run(winnerKey, workbookBytes.byteLength, NOW, workbookSha);
    });
    const put = vi.fn(async (key: string, value: unknown) => {
      if (!(value instanceof ArrayBuffer)) throw new Error("Expected an ArrayBuffer upload");
      stored.set(key, new Uint8Array(value.slice(0)));
    });
    const remove = vi.fn(async (key: string) => {
      deletedKeys.push(key);
      stored.delete(key);
    });
    const head = vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? r2Object(bytes) : null;
    });
    const env = {
      AUTH_MODE: "disabled",
      DB: d1 as unknown as D1Database,
      ASSETS: {
        put,
        delete: remove,
        head,
        get: vi.fn(async () => null),
        list: vi.fn(async () => ({ objects: [], truncated: false })),
      } as unknown as R2Bucket,
    } satisfies Env;
    const manifest = {
      schemaVersion: 2,
      title: "Race-safe imported process",
      source: {
        fileName: "race.xlsx",
        fileSha256: workbookSha,
        sheetName: "Process",
      },
      initialSubstrateStep: null,
      steps: [{
        localId: "step-1",
        sourceRow: 2,
        position: 0,
        stepNumber: "1",
        sectionName: null,
        name: "Lithography",
        toolName: null,
        parametersText: null,
        commentsText: null,
        imageIds: [],
        rawCells: {},
      }],
      images: [],
      initialStateImageIds: [],
      warnings: [],
    };
    const form = new FormData();
    form.set("workbook", new File([workbookBytes], "race.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    form.set("manifest", new File([JSON.stringify(manifest)], "manifest.json", {
      type: "application/json",
    }));

    const response = await worker.fetch(new Request(
      "https://app.test/api/imports/fabublox",
      { method: "POST", body: form },
    ), env, executionContext);
    expect(response.status).toBe(201);
    expect(injected).toBe(true);
    const result = await response.json<{ id: string; templateVersionId: string }>();
    expect(database.prepare(`
      SELECT status, workbook_asset_key, template_version_id
      FROM imports WHERE id = ?
    `).get(result.id)).toEqual({
      status: "ready",
      workbook_asset_key: winnerKey,
      template_version_id: result.templateVersionId,
    });
    expect(database.prepare(`
      SELECT source_asset_key FROM template_versions WHERE id = ?
    `).get(result.templateVersionId)).toEqual({ source_asset_key: winnerKey });
    expect(database.prepare(`
      SELECT status, import_id FROM assets WHERE id = 'fabublox-race-winner'
    `).get()).toEqual({ status: "ready", import_id: null });
    expect(deletedKeys.some((key) => key.includes("/source/race.xlsx"))).toBe(true);
    expect(deletedKeys).not.toContain(winnerKey);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM imports WHERE status = 'failed'
    `).get()).toEqual({ count: 0 });
    database.close();
  });
});
''')

# Exercise every mutable relationship locator, not only trigger-name presence.
blob_test = Path("worker/blob-integrity.test.ts")
blob_text = blob_test.read_text()
blob_text = blob_text.replace(
    'import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";',
    'import {\n  REFERENCE_FIXTURE_IDS,\n  referenceTestDatabase,\n  seedReferenceGraph,\n  SqliteD1Database,\n} from "./reference-test-support";',
    1,
)
insert_at = blob_text.rfind("\n});")
if insert_at < 0:
    raise SystemExit("worker/blob-integrity.test.ts: final describe closure not found")
blob_regression = r'''

  it("rejects UPDATE rebinding for every quarantined relationship locator", () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at
      ) VALUES
        ('asset-update-safe', 'objects/update-safe.bin', 'safe.bin',
          'application/octet-stream', 4, 'ready',
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '${NOW}'),
        ('asset-update-blocked', 'objects/update-blocked.bin', 'blocked.bin',
          'application/octet-stream', 4, 'ready',
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', '${NOW}');
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES
        ('managed-update-safe', 'switchdrive', 'objects/managed-safe.bin', 'safe.bin',
          'application/octet-stream', 4,
          '1111111111111111111111111111111111111111111111111111111111111111',
          'ready', 'user@example.com', '${NOW}'),
        ('managed-update-blocked', 'switchdrive', 'objects/managed-blocked.bin', 'blocked.bin',
          'application/octet-stream', 4,
          '2222222222222222222222222222222222222222222222222222222222222222',
          'ready', 'user@example.com', '${NOW}');
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES
        ('r2', 'r2', 'objects/update-blocked.bin', 'asset-update-blocked',
          'missing', 4, NULL, 'operation-update-r2', '${NOW}', '${NOW}'),
        ('managed', 'switchdrive', 'objects/managed-blocked.bin', 'managed-update-blocked',
          'missing', 4, NULL, 'operation-update-managed', '${NOW}', '${NOW}');
      INSERT INTO state_representations (
        hash, hash_scheme, representation_type, content_json, created_at
      ) VALUES ('state-update-guard', 'v1', 'image_set', '{}', '${NOW}');
      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('state-update-guard', 'asset-update-safe', 0);
      INSERT INTO state_verifications (
        id, sample_id, after_run_step_id, result, evidence_asset_id, created_at
      ) VALUES (
        'verification-update-guard', '${REFERENCE_FIXTURE_IDS.sampleA}',
        '${REFERENCE_FIXTURE_IDS.stepA}', 'matched', 'asset-update-safe', '${NOW}'
      );
      INSERT INTO comment_submission_items (
        id, submission_id, kind, status, position, filename, mime_type,
        byte_size, storage_object_id, created_at, updated_at
      ) VALUES (
        'managed-update-item', '${REFERENCE_FIXTURE_IDS.comment}', 'attachment',
        'ready', 1, 'safe.bin', 'application/octet-stream', 4,
        'managed-update-safe', '${NOW}', '${NOW}'
      );
      INSERT INTO projects (
        id, title, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'project-update-guard', 'Update guard', 'operation-project-update',
        'user@example.com', 'user@example.com', '${NOW}', '${NOW}'
      );
      INSERT INTO project_contents (
        id, project_id, content_type, attachment_caption, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES
        ('content-update-asset', 'project-update-guard', 'attachment', NULL,
          'operation-content-asset', 'user@example.com', 'user@example.com', '${NOW}', '${NOW}'),
        ('content-update-managed', 'project-update-guard', 'attachment', NULL,
          'operation-content-managed', 'user@example.com', 'user@example.com', '${NOW}', '${NOW}');
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-update-asset', 'asset-update-safe', 'safe.bin',
        'application/octet-stream', 4, 'user@example.com', '${NOW}',
        'operation-attachment-asset'
      );
      INSERT INTO project_content_attachments (
        project_content_id, storage_object_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-update-managed', 'managed-update-safe', 'safe.bin',
        'application/octet-stream', 4, 'user@example.com', '${NOW}',
        'operation-attachment-managed'
      );
    `);

    const updates = [
      () => database.prepare(`
        UPDATE state_representation_assets SET asset_id = 'asset-update-blocked'
        WHERE state_hash = 'state-update-guard'
      `).run(),
      () => database.prepare(`
        UPDATE run_step_assets SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.executionImage),
      () => database.prepare(`
        UPDATE metrology_template_references SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.metrologyReference),
      () => database.prepare(`
        UPDATE run_step_comments SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.commentOccurrenceA),
      () => database.prepare(`
        UPDATE state_verifications SET evidence_asset_id = 'asset-update-blocked'
        WHERE id = 'verification-update-guard'
      `).run(),
      () => database.prepare(`
        UPDATE comment_submission_items SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.commentAttachment),
      () => database.prepare(`
        UPDATE comment_submission_items SET storage_object_id = 'managed-update-blocked'
        WHERE id = 'managed-update-item'
      `).run(),
      () => database.prepare(`
        UPDATE project_content_attachments SET asset_id = 'asset-update-blocked'
        WHERE project_content_id = 'content-update-asset'
      `).run(),
      () => database.prepare(`
        UPDATE project_content_attachments SET storage_object_id = 'managed-update-blocked'
        WHERE project_content_id = 'content-update-managed'
      `).run(),
    ];
    for (const update of updates) {
      expect(update).toThrow("blob locator is quarantined");
    }

    const triggerNames = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'state_representation_assets_guard_integrity_update',
        'run_step_assets_guard_integrity_update',
        'metrology_template_references_guard_integrity_update',
        'run_step_comments_guard_integrity_update',
        'state_verifications_guard_integrity_update',
        'comment_submission_items_guard_asset_integrity_update',
        'comment_submission_items_guard_managed_integrity_update',
        'project_content_attachments_guard_asset_integrity_update',
        'project_content_attachments_guard_managed_integrity_update'
      ) ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    expect(triggerNames).toHaveLength(9);
    database.close();
  });
'''
blob_test.write_text(blob_text[:insert_at] + blob_regression + blob_text[insert_at:])

# Mobile Reading permanently covers the newly documented recoverable Markdown
# removal contract.
mobile = Path("src/project-page.mobile.mount.test.tsx")
mobile_text = mobile.read_text()
mobile_text = mobile_text.replace(
    'import { cleanup, render, screen } from "@testing-library/react";',
    'import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";',
    1,
)
mobile_at = mobile_text.rfind("\n});")
if mobile_at < 0:
    raise SystemExit("src/project-page.mobile.mount.test.tsx: final describe closure not found")
mobile_regression = r'''

  it("moves existing Markdown to trash from mobile Reading with both revision guards", async () => {
    const snapshot = projectTestSnapshot();
    const content = snapshot.contents.find((candidate) => candidate.contentType === "markdown")!;
    const item = snapshot.items.find((candidate) => candidate.projectContentId === content.id)!;
    const placement = snapshot.placements.find((candidate) => candidate.projectItemId === item.id)!;
    const deletedAt = "2026-08-14T19:00:00.000Z";
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      if (String(path) === `/api/projects/project-a/items/${item.id}` && init?.method === "DELETE") {
        return Promise.resolve(new Response(JSON.stringify({
          project: {
            ...snapshot.project,
            revision: snapshot.project.revision + 1,
            updatedAt: deletedAt,
          },
          item: {
            ...item,
            revision: item.revision + 1,
            deletedAt,
            deletedBy: "user@example.com",
            updatedAt: deletedAt,
          },
          content: {
            ...content,
            revision: content.revision + 1,
            deletedAt,
            deletedBy: "user@example.com",
            updatedAt: deletedAt,
          },
          attachment: null,
          placement,
          replayed: false,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "Unexpected request" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }));
    });

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Move Markdown to trash" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe(`/api/projects/project-a/items/${item.id}`);
    expect(request[1]?.method).toBe("DELETE");
    const body = JSON.parse(String(request[1]?.body));
    expect(body).toMatchObject({
      expectedItemRevision: item.revision,
      expectedContentRevision: content.revision,
    });
    expect(body.operationId).toEqual(expect.any(String));
    await waitFor(() => {
      expect(document.querySelector(".project-reading-markdown-source")).toBeNull();
      expect(screen.queryByRole("button", { name: "Move Markdown to trash" })).toBeNull();
    });
  });
'''
mobile.write_text(mobile_text[:mobile_at] + mobile_regression + mobile_text[mobile_at:])

replace_once(
    "package.json",
    '"test:storage-integrity": "vitest run worker/blob-integrity.test.ts worker/switchdrive-storage.test.ts"',
    '"test:storage-integrity": "vitest run worker/blob-integrity.test.ts worker/blob-integrity-routes.test.ts worker/switchdrive-storage.test.ts"',
)

replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    "Last reviewed: 2026-08-14 after the exact-head review and squash merge of PR #138",
    "Last reviewed: 2026-08-14 after the PR #141 storage-integrity and Markdown lifecycle review fixes",
)
replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    "Mobile defaults directly to Reading and never initializes React Flow. Mobile does not expose Map placement, reference insertion, attachment upload, edge authoring, occurrence removal, or any other creation/structural mutation.",
    "Mobile defaults directly to Reading and never initializes React Flow. Mobile does not expose Map placement, reference insertion, attachment upload, edge authoring, reference removal, attachment removal, or any creation operation. It may recoverably move an existing Project-owned Markdown occurrence to Trash through the same guarded item/content lifecycle operation used by desktop Reading and Map Inspector.",
)
replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    "Reading reuses the Phase 3B3 owned-content mutation machinery rather than creating new APIs. Existing Markdown and attachment metadata edits therefore retain:",
    "Reading reuses the Phase 3B3 owned-content mutation machinery and the authoritative Project-item lifecycle route rather than creating new APIs. Existing Markdown and attachment metadata edits, plus recoverable Markdown removal, therefore retain:",
)
replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    "- current authoritative expected revisions;\n- stable operation IDs;",
    "- current authoritative expected revisions, including both item and content revisions for Markdown removal;\n- stable operation IDs;",
)
replace_once(
    "docs/PROJECT_READING_IMPLEMENTATION_PLAN.md",
    "- existing Markdown update through Reading;\n- existing attachment caption/source URL update through Reading without byte retargeting;",
    "- existing Markdown update through Reading;\n- recoverable Markdown removal from desktop and mobile Reading with item/content revision guards, exact retry, and authoritative reconciliation;\n- existing attachment caption/source URL update through Reading without byte retargeting;",
)

replace_once(
    "docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md",
    "- excluding the locator from future deduplication reuse and live attachment\n  delivery;",
    "- excluding the locator from future deduplication reuse and every ordinary/live\n  media-delivery route while preserving authenticated export retrieval for\n  integrity warnings;",
)
replace_once(
    "docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md",
    "5. source/occurrence and blob metadata must still be writable and ready;\n6. the relationship write succeeds;",
    "5. ordinary/live media delivery must exclude quarantined locators, while\n   authenticated complete-export delivery remains readable for warning capture;\n6. source/occurrence and blob metadata must still be writable and ready;\n7. the relationship write succeeds;",
)
replace_once(
    "docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md",
    "7. an unclaimed `orphaned` row is released atomically.",
    "8. an unclaimed `orphaned` row is released atomically.",
)

replace_once(
    "docs/BLOB_LIFECYCLE_OPERATIONS.md",
    "A provider/authentication/transport failure must never create a quarantine row.\nThe operation fails with a retryable service response and leaves metadata,\nretention edges, and ledger state unchanged.",
    "A provider/authentication/transport failure must never create a quarantine row.\nThe operation fails with a retryable service response and leaves metadata,\nretention edges, and ledger state unchanged. Ordinary/live media routes exclude\nquarantined locators; authenticated complete-export routes deliberately retain\nread access so size/hash verification can record the failure in the export\nmanifest and warnings.",
)
