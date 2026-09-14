// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import { ProjectPage } from "../src/pages/ProjectPage";
import { projectApi } from "../src/lib/project-client";
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from "../src/lib/project-map-model";
import worker from "./index";
import { createProject, createMarkdownProjectItem, createReferenceProjectItem, createProjectEdge } from "./projects/service";
import type { Env } from "./types";

// Run directly: npx vitest run worker/backend-reliability-scale.test.ts --disableConsoleIntercept
// Timings describe this local Worker/SQLite process only. Query/request counts
// and payload sizes are diagnostics, not production latency or performance gates.
vi.mock("../src/components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));
vi.mock("../src/components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: ({ nodes, onGeometryBatchCommit }: {
    nodes: ProjectNodeDescriptor[];
    onGeometryBatchCommit: (commands: ProjectGeometryCommand[]) => void;
  }) => createElement("button", { onClick: () => onGeometryBatchCommit(nodes.map((node) => ({
    placementId: node.placementId, before: node.geometry, after: { ...node.geometry, x: node.geometry.x + 80 },
  }))) }, "Move all cards"),
}));

const ACTOR = "synthetic-scale@example.com";
const NOW = "2026-09-13T00:00:00.000Z";
const PROJECT_ID = "backend-reliability-scale";
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const geometry = (index: number) => ({ x: index * 10, y: 0, width: 320, height: 180, zIndex: 0 });

function testDatabase() {
  let queryCount = 0;
  const database = new DatabaseSync(':memory:');
  const directory = `${process.cwd()}/migrations`;
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(`${directory}/${file}`, 'utf8'));
  }
  function statement(sql: string, values: unknown[] = []) {
    const execute = () => {
      queryCount++;
      const prepared = database.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) return { results:prepared.all(...values as []), success:true, meta:{changes:0} };
      return { results:[], success:true, meta:{changes:Number(prepared.run(...values as []).changes)} };
    };
    return {
      bind:(...bindings: unknown[]) => statement(sql, bindings),
      execute, run:async () => execute(), all:async () => execute(),
      first:async () => { queryCount++; return database.prepare(sql).get(...values as []) ?? null; },
    };
  }
  const db = {
    prepare:statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      database.exec('BEGIN');
      try { const results=statements.map(statement => statement.execute()); database.exec('COMMIT'); return results; }
      catch(error) { database.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { database, db, queryCount: () => queryCount, resetQueryCount: () => { queryCount = 0; } };
}

async function fixture() {
  const local = testDatabase();
  const env = { AUTH_MODE: "disabled", DB: local.db, ASSETS: {} as R2Bucket } satisfies Env;
  await createProject(local.db, { id: PROJECT_ID, title: "Synthetic reliability scale", operationId: "create-scale" }, ACTOR, NOW);
  return {
    ...local,
    request(path = "", init?: RequestInit) {
      return worker.fetch(new Request(`https://app.test/api/projects/${PROJECT_ID}${path}`, init), env, context);
    },
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("backend reliability scale characterization", () => {
  // Full-suite workers contend while each fixture applies the complete reviewed
  // migration chain. Keep the measured request diagnostics non-gating, as the
  // characterization contract above specifies, without a 5 s harness race.
  it.each([200, 201, 500])("retains %i distinct references across resolver batches", async (count) => {
    const f = await fixture();
    try {
      const targets = Array.from({ length: count }, (_, index) => ({ type: "sample" as const, id: `sample-${String(index).padStart(4, "0")}` }));
      for (const [index, target] of targets.entries()) {
        f.database.prepare("INSERT INTO samples (id, code, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(target.id, `S-${index}`, `Synthetic sample ${index}`, NOW, NOW);
        await createReferenceProjectItem(f.db, PROJECT_ID, {
          itemId: `item-${index}`, placementId: `placement-${index}`, target, geometry: geometry(index),
          expectedProjectRevision: index + 1, operationId: `create-${index}`,
        }, ACTOR, NOW);
      }
      f.resetQueryCount();
      const started = performance.now();
      const response = await f.request();
      const bytes = await response.text();
      const snapshot = JSON.parse(bytes) as ProjectSnapshot;
      const elapsedMs = performance.now() - started;
      expect(response.status).toBe(200);
      expect(snapshot.items.map(item => item.id)).toEqual(targets.map((_, index) => `item-${index}`));
      expect(snapshot.placements.map(placement => placement.id)).toEqual(targets.map((_, index) => `placement-${index}`));
      expect(snapshot.references.map(reference => reference.resolution.target)).toEqual(targets);
      expect(snapshot.references.every(reference => reference.resolution.resolution === "resolved")).toBe(true);
      console.info("backend-reliability-scale", JSON.stringify({
        environment: "local-worker-sqlite", distinctTargets: count, requests: 1,
        sqlStatements: f.queryCount(), responseBytes: new TextEncoder().encode(bytes).length, elapsedMs,
      }));
    } finally { f.database.close(); }
  }, 15_000);

  it.each([[250, 400], [500, 800]])("retains %i nodes/%i edges and waits for every placement ACK", async (count, edgeCount) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, media: "(min-width: 860px)", onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const f = await fixture();
    let releaseFinalAck = () => undefined;
    try {
      for (let index = 0; index < count; index++) await createMarkdownProjectItem(f.db, PROJECT_ID, {
        itemId: `item-${index}`, contentId: `content-${index}`, placementId: `placement-${index}`,
        markdownSource: `Synthetic card ${index}`, geometry: geometry(index),
        expectedProjectRevision: index + 1, operationId: `create-${index}`,
      }, ACTOR, NOW);
      for (let index = 0; index < edgeCount; index++) await createProjectEdge(f.db, PROJECT_ID, {
        edgeId: `edge-${index}`, sourceItemId: `item-${index % count}`, targetItemId: `item-${(index + 1 + Math.floor(index / count)) % count}`,
        sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "none", label: null,
        expectedSourceItemRevision: 1, expectedTargetItemRevision: 1, operationId: `create-edge-${index}`,
      }, ACTOR, NOW);
      let snapshotQueries = 0, snapshotBytes = 0, snapshotMs = 0, requests = 0, patches = 0;
      let concurrent = 0, maxConcurrent = 0, finalAckReady = false;
      const acknowledged = new Set<string>();
      const finalAck = new Promise<void>(resolve => { releaseFinalAck = resolve; });
      const read = vi.spyOn(projectApi, "read").mockImplementation(async () => {
        f.resetQueryCount();
        const started = performance.now();
        const response = await f.request();
        requests++;
        const bytes = await response.text();
        const snapshot = JSON.parse(bytes) as ProjectSnapshot;
        expect(response.status).toBe(200);
        expect(snapshot.items.map(item => item.id)).toEqual(Array.from({ length: count }, (_, index) => `item-${index}`));
        expect(snapshot.edges.map(edge => edge.id).sort()).toEqual(Array.from({ length: edgeCount }, (_, index) => `edge-${index}`).sort());
        snapshotQueries = f.queryCount();
        snapshotBytes = new TextEncoder().encode(bytes).length;
        snapshotMs = performance.now() - started;
        f.resetQueryCount();
        return snapshot;
      });
      const update = vi.spyOn(projectApi, "updatePlacement").mockImplementation(async (projectId, placementId, input) => {
        expect(projectId).toBe(PROJECT_ID);
        requests++; patches++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        const response = await f.request(`/placements/${encodeURIComponent(placementId)}`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
        });
        expect(response.status).toBe(200);
        const payload = await response.json() as Awaited<ReturnType<typeof projectApi.updatePlacement>>;
        expect(payload.value).toMatchObject({ id: placementId, ...input.geometry, revision: input.expectedRevision + 1 });
        if (patches === count) { finalAckReady = true; await finalAck; }
        acknowledged.add(placementId);
        concurrent--;
        return payload;
      });
      const router = createMemoryRouter([{ path: "/projects/:projectId", element: createElement(ProjectPage) }], {
        initialEntries: [`/projects/${PROJECT_ID}`],
      });
      render(createElement(RouterProvider, { router }));
      const move = await screen.findByRole("button", { name: "Move all cards" });
      const started = performance.now();
      fireEvent.click(move);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(finalAckReady).toBe(true), { timeout: 20_000 });
      const toFinalResponseMs = performance.now() - started;
      expect(acknowledged.size).toBe(count - 1);
      expect(screen.queryByText("Saved")).toBeNull();
      expect(screen.getByText("Saving")).toBeTruthy();
      const ackStarted = performance.now();
      releaseFinalAck();
      await screen.findByText("Saved");
      const ackToSavedMs = performance.now() - ackStarted;
      expect([...acknowledged].sort()).toEqual(Array.from({ length: count }, (_, index) => `placement-${index}`).sort());
      expect(update.mock.calls.map(call => call[1]).sort()).toEqual([...acknowledged].sort());
      expect(read).toHaveBeenCalledTimes(1);
      const saved = f.database.prepare("SELECT id, x, revision FROM project_map_placements ORDER BY id").all();
      expect(saved).toEqual(Array.from({ length: count }, (_, index) => ({ id: `placement-${index}`, x: index * 10 + 80, revision: 2 }))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      console.info("backend-reliability-scale", JSON.stringify({
        environment: "mounted-page-local-worker-sqlite", nodes: count, edges: edgeCount, requests, patches, maxConcurrent,
        snapshotQueries, snapshotBytes, snapshotMs, saveQueries: f.queryCount(), toFinalResponseMs, ackToSavedMs,
      }));
    } finally { releaseFinalAck(); cleanup(); f.database.close(); }
  }, 30_000);
});
