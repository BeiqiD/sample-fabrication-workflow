import { describe, expect, it, vi } from "vitest";
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

const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function streamBytes() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(imageBytes);
      controller.close();
    },
  });
}

function assetBucket() {
  return {
    async get(key: string) {
      if (key !== "reference/private/execution.png") return null;
      return {
        body: streamBytes(),
        httpEtag: '"reference-etag"',
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", "image/png");
        },
      };
    },
  } as unknown as R2Bucket;
}

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  const env: Env = {
    AUTH_MODE: "disabled",
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: assetBucket(),
  };
  return { database, env };
}

function mediaRequest(
  env: Env,
  executionImageId: string,
  stepId: string | null,
) {
  const query = stepId === null ? "" : `?${new URLSearchParams({ step: stepId })}`;
  return worker.fetch(new Request(
    `https://app.test/api/references/media/execution_image/${encodeReferenceRouteId(executionImageId)}${query}`,
  ), env, executionContext);
}

describe("stable execution-image media route", () => {
  it("streams bytes only when the stable occurrence belongs to the requested active Step", async () => {
    const { database, env } = fixture();
    const get = vi.spyOn(env.ASSETS, "get");
    const response = await mediaRequest(
      env,
      REFERENCE_FIXTURE_IDS.executionImage,
      REFERENCE_FIXTURE_IDS.stepA,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("execution.png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes);

    const wrongContext = await mediaRequest(
      env,
      REFERENCE_FIXTURE_IDS.executionImage,
      REFERENCE_FIXTURE_IDS.stepB,
    );
    expect(wrongContext.status).toBe(404);
    expect(get).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("rejects missing or malformed context and does not reinterpret non-execution assets", async () => {
    const { database, env } = fixture();
    const missingContext = await mediaRequest(env, REFERENCE_FIXTURE_IDS.executionImage, null);
    expect(missingContext.status).toBe(400);

    const malformed = await worker.fetch(new Request(
      "https://app.test/api/references/media/execution_image/not-opaque?step=reference-step-a",
    ), env, executionContext);
    expect(malformed.status).toBe(400);

    database.prepare(`
      INSERT INTO run_step_assets
        (id, run_step_id, asset_id, role, position, created_at)
      VALUES ('reference-state-observation', ?, 'reference-execution-asset',
              'state_observation', 1, '2026-08-08T12:00:00.000Z')
    `).run(REFERENCE_FIXTURE_IDS.stepA);
    const observation = await mediaRequest(
      env,
      "reference-state-observation",
      REFERENCE_FIXTURE_IDS.stepA,
    );
    expect(observation.status).toBe(404);
    database.close();
  });

  it("fails closed after the occurrence or an ancestor is soft-deleted", async () => {
    const { database, env } = fixture();
    database.prepare("UPDATE run_step_assets SET deleted_at = ? WHERE id = ?")
      .run("2026-08-08T13:00:00.000Z", REFERENCE_FIXTURE_IDS.executionImage);
    expect((await mediaRequest(
      env,
      REFERENCE_FIXTURE_IDS.executionImage,
      REFERENCE_FIXTURE_IDS.stepA,
    )).status).toBe(404);

    database.prepare("UPDATE run_step_assets SET deleted_at = NULL WHERE id = ?")
      .run(REFERENCE_FIXTURE_IDS.executionImage);
    database.prepare("UPDATE runs SET deleted_at = ? WHERE id = ?")
      .run("2026-08-08T13:00:00.000Z", REFERENCE_FIXTURE_IDS.runA);
    expect((await mediaRequest(
      env,
      REFERENCE_FIXTURE_IDS.executionImage,
      REFERENCE_FIXTURE_IDS.stepA,
    )).status).toBe(404);
    database.close();
  });

it("shares the hardened MIME policy with ordinary asset reads", async () => {
  const { database, env } = fixture();
  const ordinary = await worker.fetch(new Request(
    "https://app.test/api/assets/reference/private/execution.png",
  ), env, executionContext);
  expect(ordinary.status).toBe(200);
  expect(ordinary.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(ordinary.headers.get("x-content-type-options")).toBe("nosniff");

  database.prepare("UPDATE assets SET mime_type = ? WHERE id = ?")
    .run("image/svg+xml", "reference-execution-asset");
  for (const response of [
    await mediaRequest(env, REFERENCE_FIXTURE_IDS.executionImage, REFERENCE_FIXTURE_IDS.stepA),
    await worker.fetch(new Request(
      "https://app.test/api/assets/reference/private/execution.png",
    ), env, executionContext),
  ]) {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }

  database.prepare("UPDATE assets SET mime_type = ? WHERE id = ?")
    .run("text/html", "reference-execution-asset");
  const activeContent = await mediaRequest(
    env,
    REFERENCE_FIXTURE_IDS.executionImage,
    REFERENCE_FIXTURE_IDS.stepA,
  );
  expect(activeContent.status).toBe(200);
  expect(activeContent.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(activeContent.headers.get("content-security-policy")).toContain("sandbox");
  database.close();
});

const byteReadRoutes = [
  {
    name: "ordinary asset",
    path: "/api/assets/reference/private/execution.png",
    cacheControl: "private, max-age=3600",
    missingMessage: "Asset not found",
  },
  {
    name: "execution image",
    path: `/api/references/media/execution_image/${encodeReferenceRouteId(REFERENCE_FIXTURE_IDS.executionImage)}?step=${REFERENCE_FIXTURE_IDS.stepA}`,
    cacheControl: "private, no-store",
    missingMessage: "Execution image bytes are unavailable",
  },
];

describe.each(byteReadRoutes)("$name byte-reader boundary", ({ path, cacheControl, missingMessage }) => {
  it("preserves representation metadata while enforcing the application media policy", async () => {
    const { database, env } = fixture();
    env.ASSETS = {
      async get() {
        return {
          body: streamBytes(),
          httpEtag: '"representation-etag"',
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "text/html");
            headers.set("content-encoding", "gzip");
            headers.set("content-language", "zh-CN");
            headers.set("expires", "Wed, 21 Oct 2037 07:28:00 GMT");
            headers.set("cache-control", "public, max-age=31536000");
            headers.set("content-disposition", "attachment; filename=provider.html");
          },
        };
      },
    } as unknown as R2Bucket;
    try {
      const response = await worker.fetch(new Request(`https://app.test${path}`), env, executionContext);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(response.headers.get("content-language")).toBe("zh-CN");
      expect(response.headers.get("expires")).toBe("Wed, 21 Oct 2037 07:28:00 GMT");
      expect(response.headers.get("etag")).toBe('"representation-etag"');
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe(cacheControl);
      expect(response.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''execution.png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("content-security-policy")).toBeNull();
      // The transport and response policy preserve opaque bytes without decoding.
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes);
    } finally { database.close(); }
  });

  it("distinguishes missing bytes from a provider failure without disclosing its message", async () => {
    const { database, env } = fixture();
    const get = vi.fn().mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("private-bucket credential=secret-provider-token"));
    env.ASSETS = { get } as unknown as R2Bucket;
    try {
      const missing = await worker.fetch(new Request(`https://app.test${path}`), env, executionContext);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: missingMessage });
      const unavailable = await worker.fetch(new Request(`https://app.test${path}`), env, executionContext);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: "R2 is unavailable" });
      expect(get).toHaveBeenCalledTimes(2);
    } finally { database.close(); }
  });

  it("rejects unpublished sources before requesting provider bytes", async () => {
    const { database, env } = fixture();
    const get = vi.fn();
    env.ASSETS = { get } as unknown as R2Bucket;
    try {
      database.prepare("UPDATE assets SET status = 'pending' WHERE id = ?")
        .run("reference-execution-asset");
      const response = await worker.fetch(new Request(`https://app.test${path}`), env, executionContext);
      expect(response.status).toBe(404);
      expect(get).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it("rejects unauthenticated requests before requesting provider bytes", async () => {
    const { database, env } = fixture();
    const get = vi.fn();
    env.ASSETS = { get } as unknown as R2Bucket;
    env.AUTH_MODE = "access";
    env.ACCESS_TEAM_DOMAIN = "https://access.example";
    env.ACCESS_AUD = "application-audience";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(new Request(`https://app.test${path}`), env, executionContext);
      expect(response.status).toBe(403);
      expect(get).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      database.close();
    }
  });
});

it.each(["deleting", "deleted"] as const)(
  "rejects %s R2 locators from both media paths",
  async (state) => {
    const { database, env } = fixture();
    database.prepare(`
      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state, operation_id, updated_at)
      VALUES ('r2', 'r2', 'reference/private/execution.png',
              'reference-execution-asset', ?, 'reference-media-test', ?)
    `).run(state, "2026-08-08T13:00:00.000Z");

    expect((await mediaRequest(
      env,
      REFERENCE_FIXTURE_IDS.executionImage,
      REFERENCE_FIXTURE_IDS.stepA,
    )).status).toBe(404);
    expect((await worker.fetch(new Request(
      "https://app.test/api/assets/reference/private/execution.png",
    ), env, executionContext)).status).toBe(404);
    database.close();
  },
);

});
