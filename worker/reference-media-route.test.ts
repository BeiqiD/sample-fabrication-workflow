import { describe, expect, it } from "vitest";
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
    const response = await mediaRequest(
      env,
      REFERENCE_FIXTURE_IDS.executionImage,
      REFERENCE_FIXTURE_IDS.stepA,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("execution.png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes);

    const wrongContext = await mediaRequest(
      env,
      REFERENCE_FIXTURE_IDS.executionImage,
      REFERENCE_FIXTURE_IDS.stepB,
    );
    expect(wrongContext.status).toBe(404);
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
});
