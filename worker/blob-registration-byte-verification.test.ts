import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import {
  AttachmentIngestionByteSizeMismatchError,
  AttachmentIngestionHashMismatchError,
  AttachmentIngestionUnavailableError,
  ingestManagedAttachment,
  ingestR2Attachment,
} from "./attachment-ingestion";
import {
  BlobRegistrationAuthorityUnavailableError,
  registerManagedObject,
  registerR2Asset,
} from "./blob-lifecycle/registration";
import { runBlobGarbageCollection } from "./blob-lifecycle/gc";
import type { ReusableManagedObject, ReusableR2Asset } from "./blob-lifecycle/reuse";
import type { ManagedStorage } from "./managed-storage";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const bytes = Uint8Array.from([1, 2, 3, 4]);
const corrupt = Uint8Array.from([4, 3, 2, 1]);
const array = (value: Uint8Array) => value.slice().buffer as ArrayBuffer;
const stream = (value: Uint8Array) => new Response(value).body!;

function brokenStream(value: Uint8Array) {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.error(new Error("private destination stream failure"));
      else {
        sent = true;
        controller.enqueue(value);
      }
    },
  });
}

function fixture() {
  const database = referenceTestDatabase();
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: ArrayBuffer) => {
    objects.set(key, new Uint8Array(value.slice(0)));
  });
  const get = vi.fn(async (key: string) => {
    const value = objects.get(key);
    return value ? {
      body: stream(value),
      size: value.byteLength,
      httpEtag: '"untrusted-etag"',
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", "application/octet-stream");
      },
    } : null;
  });
  const remove = vi.fn(async (key: string) => { objects.delete(key); });
  const env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {
      put, get, delete: remove,
      head: vi.fn(async (key: string) => {
        const value = objects.get(key);
        return value ? { size: value.byteLength } : null;
      }),
    } as unknown as R2Bucket,
  } satisfies Env;
  return { database, objects, put, get, remove, env };
}

function managedFixture() {
  const state = fixture();
  const put = vi.fn(async (input: Parameters<ManagedStorage["put"]>[0]) => {
    const uploaded = new Uint8Array(await new Response(input.body).arrayBuffer());
    state.objects.set(input.key, uploaded);
    return { byteSize: uploaded.byteLength };
  });
  const get = vi.fn(async (key: string) => {
    const value = state.objects.get(key);
    return value ? {
      body: stream(value), contentType: "application/octet-stream", etag: '"untrusted-etag"',
    } : null;
  });
  const storage: ManagedStorage = {
    provider: "switchdrive", authentication: "service_binding",
    check: vi.fn(async () => undefined), put, get,
    stat: vi.fn(async (key: string) => {
      const value = state.objects.get(key);
      return value ? { byteSize: value.byteLength, contentType: "application/octet-stream", etag: null } : null;
    }),
    delete: state.remove,
  };
  return { ...state, storage, managedPut: put, managedGet: get };
}

async function input(body = stream(bytes)) {
  return {
    id: "candidate", objectKey: "candidate-key", originalName: "file.dat",
    mimeType: "application/octet-stream", byteSize: bytes.byteLength,
    sha256: await sha256Hex(array(bytes)), actorEmail: "local-development", body,
  };
}

async function ingestManaged(state: ReturnType<typeof managedFixture>, body = stream(bytes)) {
  const value = await input(body);
  return ingestManagedAttachment(state.env, state.storage, {
    ...value, registrationId: value.id, objectKey: () => value.objectKey,
  });
}

async function seedManagedWinner(state: ReturnType<typeof managedFixture>, id = "winner") {
  const expected = await input();
  const winner: ReusableManagedObject = {
    id, provider: "switchdrive", object_key: `${id}-key`, original_name: "file.dat",
    mime_type: "application/octet-stream", byte_size: bytes.byteLength, sha256: expected.sha256,
  };
  state.database.prepare(`
    INSERT INTO managed_storage_objects
      (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, actor_email, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'local-development', ?)
  `).run(winner.id, winner.provider, winner.object_key, winner.original_name,
    winner.mime_type, winner.byte_size, winner.sha256, new Date().toISOString());
  state.objects.set(winner.object_key, bytes);
  return winner;
}

async function assertCandidateTracked(state: ReturnType<typeof fixture>, kind: "r2" | "managed") {
  const table = kind === "r2" ? "assets" : "managed_storage_objects";
  expect(state.database.prepare(`SELECT status FROM ${table} WHERE id = 'candidate'`).get())
    .toEqual({ status: kind === "r2" ? "pending" : "failed" });
  expect(state.database.prepare("SELECT COUNT(*) AS count FROM blob_integrity_quarantine").get())
    .toEqual({ count: 0 });
  expect(state.remove).not.toHaveBeenCalled();
  const result = await runBlobGarbageCollection(state.env, new Date(Date.now() + 25 * 60 * 60 * 1_000));
  expect(result.orphanCandidatesMarked).toBe(1);
  expect(state.database.prepare("SELECT state FROM blob_gc_ledger WHERE object_key = 'candidate-key'").get())
    .toEqual({ state: "orphaned" });
  expect(state.remove).not.toHaveBeenCalled();
}

afterEach(() => vi.restoreAllMocks());

describe("registration verifies byte identity before publication", () => {
  it("keeps a same-size corrupt R2 PUT non-public and discoverable to GC", async () => {
    const state = fixture();
    state.put.mockImplementation(async (key) => { state.objects.set(key, corrupt); });
    await expect(ingestR2Attachment(state.env, {
      originalName: "file.dat", mimeType: "application/octet-stream", actorEmail: "local-development",
      bytes: array(bytes), registrationId: "candidate", objectKey: () => "candidate-key",
    })).rejects.toBeInstanceOf(AttachmentIngestionUnavailableError);
    expect(state.put).toHaveBeenCalledTimes(1);
    await assertCandidateTracked(state, "r2");
    const collected = await runBlobGarbageCollection(state.env, new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000));
    expect(collected.imageDeleted).toBe(1);
    expect(state.remove).toHaveBeenCalledWith("candidate-key");
  });

  it("does not promote R2 bytes when the readback fails after its final data chunk", async () => {
    const state = fixture();
    state.get.mockImplementation(async () => ({
      body: brokenStream(bytes), size: bytes.byteLength, httpEtag: '"not-a-digest"',
      writeHttpMetadata() {},
    }));
    await expect(registerR2Asset(state.env, {
      ...await input(), bytes: array(bytes), findWinner: async () => null,
    })).rejects.toBeInstanceOf(BlobRegistrationAuthorityUnavailableError);
    await assertCandidateTracked(state, "r2");
  });

  it("does not replay an R2 PUT whose success response was lost", async () => {
    const state = fixture();
    state.put.mockImplementation(async (key, body) => {
      state.objects.set(key, new Uint8Array(body));
      throw new Error("private PUT response loss");
    });
    await expect(registerR2Asset(state.env, {
      ...await input(), bytes: array(bytes), findWinner: async () => null,
    })).rejects.toBeInstanceOf(BlobRegistrationAuthorityUnavailableError);
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(state.get).not.toHaveBeenCalled();
    await assertCandidateTracked(state, "r2");
  });

  it.each(["winner", "exact-ready"] as const)("verifies R2 %s bytes before returning", async (path) => {
    const state = fixture();
    const value = await input();
    const winner: ReusableR2Asset = {
      id: "candidate", r2_key: value.objectKey, original_name: value.originalName,
      mime_type: value.mimeType, byte_size: value.byteSize, sha256: value.sha256,
    };
    state.database.prepare(`
      INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, actor_email, created_at)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, 'local-development', ?)
    `).run(winner.id, winner.r2_key, winner.original_name, winner.mime_type,
      winner.byte_size, winner.sha256, new Date().toISOString());
    state.objects.set(value.objectKey, corrupt);
    await expect(registerR2Asset(state.env, {
      ...value, bytes: array(bytes), findWinner: async () => path === "winner" ? winner : null,
    })).rejects.toBeInstanceOf(BlobRegistrationAuthorityUnavailableError);
    expect(state.put).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("publishes a managed candidate only after consuming the source and verifying the destination", async () => {
    const state = managedFixture();
    state.managedGet.mockImplementation(async (key) => {
      expect(state.database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'candidate'").get())
        .toEqual({ status: "failed" });
      return { body: stream(state.objects.get(key)!), contentType: "application/octet-stream", etag: null };
    });
    const result = await ingestManaged(state);
    expect(result.handle.sha256).toBe(await sha256Hex(array(bytes)));
    expect(state.database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'candidate'").get())
      .toEqual({ status: "ready" });
    expect(state.managedPut).toHaveBeenCalledTimes(1);
    expect(state.managedGet).toHaveBeenCalledTimes(1);
  });

  it("rejects a false managed source hash and preserves its staging identity", async () => {
    const state = managedFixture();
    await expect(ingestManaged(state, stream(corrupt)))
      .rejects.toBeInstanceOf(AttachmentIngestionHashMismatchError);
    expect(state.managedPut).toHaveBeenCalledTimes(1);
    expect(state.managedGet).not.toHaveBeenCalled();
    await assertCandidateTracked(state, "managed");
  });

  it.each([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4, 5])])(
    "rejects a managed source with a different actual size", async (uploaded) => {
      const state = managedFixture();
      await expect(ingestManaged(state, stream(uploaded)))
        .rejects.toBeInstanceOf(AttachmentIngestionByteSizeMismatchError);
      await assertCandidateTracked(state, "managed");
    },
  );

  it.each(["corrupt", "late-error"] as const)("does not publish a managed %s destination", async (failure) => {
    const state = managedFixture();
    state.managedGet.mockImplementation(async () => ({
      body: failure === "corrupt" ? stream(corrupt) : brokenStream(bytes),
      contentType: "application/octet-stream", etag: '"arbitrary-etag"',
    }));
    await expect(ingestManaged(state)).rejects.toBeInstanceOf(AttachmentIngestionUnavailableError);
    await assertCandidateTracked(state, "managed");
  });

  it("does not replay a managed PUT whose success response was lost", async () => {
    const state = managedFixture();
    state.managedPut.mockImplementation(async (value) => {
      state.objects.set(value.key, new Uint8Array(await new Response(value.body).arrayBuffer()));
      throw new Error("private PUT response loss");
    });
    await expect(ingestManaged(state)).rejects.toBeInstanceOf(AttachmentIngestionUnavailableError);
    expect(state.managedPut).toHaveBeenCalledTimes(1);
    expect(state.managedGet).not.toHaveBeenCalled();
    await assertCandidateTracked(state, "managed");
  });

  it.each(["winner", "exact-ready"] as const)("validates the request body before accepting a managed %s", async (path) => {
    const state = managedFixture();
    const winner = await seedManagedWinner(state, path === "exact-ready" ? "candidate" : "winner");
    await expect(registerManagedObject(state.env, state.storage, {
      ...await input(stream(corrupt)), findWinner: async () => path === "winner" ? winner : null,
    })).rejects.toMatchObject({ phase: "source", reason: "hash_mismatch" });
    expect(state.managedPut).not.toHaveBeenCalled();
    expect(state.managedGet).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("rejects same-size corrupt managed winner bytes after validating a matching request", async () => {
    const state = managedFixture();
    const winner = await seedManagedWinner(state);
    state.objects.set(winner.object_key, corrupt);
    await expect(registerManagedObject(state.env, state.storage, {
      ...await input(), findWinner: async () => winner,
    })).rejects.toBeInstanceOf(BlobRegistrationAuthorityUnavailableError);
    expect(state.managedPut).not.toHaveBeenCalled();
    expect(state.managedGet).toHaveBeenCalledTimes(1);
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("checks a competing managed winner after PUT without consuming the source twice", async () => {
    const state = managedFixture();
    let winner: ReusableManagedObject | null = null;
    state.managedPut.mockImplementation(async (value) => {
      const uploaded = new Uint8Array(await new Response(value.body).arrayBuffer());
      state.objects.set(value.key, uploaded);
      winner = await seedManagedWinner(state);
      return { byteSize: uploaded.byteLength };
    });
    const result = await registerManagedObject(state.env, state.storage, {
      ...await input(), findWinner: async () => winner,
    });
    expect(result).toMatchObject({ object: { id: "winner" }, deduplicated: true });
    expect(state.managedPut).toHaveBeenCalledTimes(1);
    expect(state.managedGet.mock.calls.map(([key]) => key)).toEqual(["candidate-key", "winner-key"]);
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.database.prepare("SELECT status FROM managed_storage_objects WHERE id = 'candidate'").get())
      .toEqual({ status: "failed" });
  });
});
