import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { verifySharedBoundary } from "./verify-shared-boundary.mjs";

async function fixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), "shared-boundary-"));
  try {
    for (const [filename, source] of Object.entries(files)) {
      const target = join(root, filename);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("shared contracts, pure helpers and compatibility re-exports keep allowed dependencies", () => fixture({
  "shared/types.ts": 'export * from "./contracts/types";',
  "shared/contracts/types.ts": 'import type { Value } from "../domain/value"; export type DTO = Value;',
  "shared/domain/value.ts": 'export type Value = string; // import "react"\nexport const text = "require(\\\"node:fs\\\")";',
  "shared/helper.test.ts": 'import "node:fs"; import "../src/fixture";',
}, async (root) => assert.equal(await verifySharedBoundary(root), 3)));

for (const source of [
  'import type { Env } from "../../worker/env";',
  'export type { View } from "../../src/view";',
  'export * from "node:fs";',
  'import React from "react";',
  'type Bucket = import("@cloudflare/workers-types").R2Bucket;',
  'const load = () => import("../../worker/storage");',
  'import provider = require("../../worker/provider");',
  'const provider = require("node:fs");',
  'const load = (name: string) => import(name);',
  '/// <reference types="@cloudflare/workers-types" />\nexport type Bucket = R2Bucket;',
]) {
  test(`rejects a shared boundary violation: ${source.split("\n")[0]}`, () => fixture({
    "shared/contracts/invalid.ts": source,
  }, (root) => assert.rejects(() => verifySharedBoundary(root), /forbidden|must stay|string literals|ambient reference/)));
}

test("domain cannot import contracts, even as a type", () => fixture({
  "shared/contracts/types.ts": "export type DTO = string;",
  "shared/domain/value.ts": 'import type { DTO } from "../contracts/types"; export type Value = DTO;',
}, (root) => assert.rejects(() => verifySharedBoundary(root), /domain cannot depend on contracts/)));

test("a compatibility path cannot hide application code or a dependency outside shared", () => fixture({
  "shared/types.ts": 'export * from "../worker/types";',
}, (root) => assert.rejects(() => verifySharedBoundary(root), /must stay/)));

test("a compatibility path cannot acquire its own implementation", () => fixture({
  "shared/types.ts": 'export * from "./contracts/types"; export const policy = true;',
  "shared/contracts/types.ts": "export type DTO = string;",
}, (root) => assert.rejects(() => verifySharedBoundary(root), /compatibility re-export/)));
