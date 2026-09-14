import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import { COMMENT_ACCEPTANCE_PROTOCOL, type AcceptedCommentSubmissionInput } from "../shared/contracts/comment-acceptance";
import worker from "./index";
import type { Env } from "./types";

export const COMMENT_TEST_R2_NAMESPACE = JSON.stringify({ kind: "local-r2",
  installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "test-assets" });

/** Exercise the actual acceptance route so integrity/race tests cannot silently
 * fall back to unfinished, pre-negotiation Comment fixtures. */
export async function acceptCommentSubmission(env: Env, input: Omit<AcceptedCommentSubmissionInput, "protocol">) {
  env.R2_BOOTSTRAP_NAMESPACE ??= COMMENT_TEST_R2_NAMESPACE;
  const response = await worker.fetch(new Request("https://app.test/api/comment-submissions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, protocol: COMMENT_ACCEPTANCE_PROTOCOL }),
  }), env, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext);
  const body = await response.text();
  expect(response.status, body).toBe(201);
  expect(JSON.parse(body)).toMatchObject({ request: { submissionId: input.id, status: "pending" } });
}

export async function acceptCommentUpload(database: DatabaseSync, env: Env, input: {
  kind: "comment_image" | "attachment";
  bytes: Uint8Array;
  sha256?: string;
  sampleId?: string;
  submissionId?: string;
  itemId?: string;
  filename?: string;
}) {
  const sampleId = input.sampleId ?? "sample-upload";
  const sample = database.prepare("SELECT updated_at FROM samples WHERE id = ?").get(sampleId) as { updated_at: string };
  const sha256 = input.sha256 ?? await sha256Hex(input.bytes.buffer.slice(input.bytes.byteOffset,
    input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer);
  await acceptCommentSubmission(env, {
    id: input.submissionId ?? "submission-upload", body: "",
    context: { kind: "sample", sampleId, expectedUpdatedAt: sample.updated_at },
    items: [input.kind === "comment_image" ? {
      id: input.itemId ?? "item-upload", kind: "comment_image", filename: input.filename ?? "image.png",
      mimeType: "image/png", byteSize: input.bytes.byteLength, sha256,
      originalFilename: input.filename ?? "image.png", originalMimeType: "image/png", originalByteSize: input.bytes.byteLength,
    } : {
      id: input.itemId ?? "item-upload", kind: "attachment", filename: input.filename ?? "result.dat",
      mimeType: "application/octet-stream", byteSize: input.bytes.byteLength, sha256,
    }],
  });
  expect(database.prepare("SELECT count(*) n FROM comment_submission_acceptances WHERE submission_id = ?")
    .get(input.submissionId ?? "submission-upload")).toEqual({ n: 1 });
}

export async function uploadAcceptedCommentItem(env: Env, submissionId: string, itemId: string,
  kind: "comment_image" | "attachment", bytes: Uint8Array) {
  const response = await worker.fetch(new Request(`https://app.test/api/comment-submissions/${submissionId}/items/${itemId}/content`, {
    method: "PUT", headers: { "content-type": kind === "comment_image" ? "image/png" : "application/octet-stream",
      "x-upload-size": String(bytes.byteLength),
      "x-content-sha256": await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) },
    body: new Uint8Array(bytes).buffer,
  }), env, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext);
  const body = await response.text();
  expect(response.status, body).toBe(200);
}

/** A byte-preserving WebDAV fake; create, upload and later readiness checks all
 * use the same provider objects through the production adapter. */
export function commentManagedFetch() {
  const objects = new Map<string, Uint8Array>();
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    if (method === "PROPFIND") return new Response(null, { status: 207 });
    if (method === "MKCOL") return new Response(null, { status: 201 });
    if (method === "PUT") {
      objects.set(url, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
      return new Response(null, { status: 201 });
    }
    if (method === "DELETE") { objects.delete(url); return new Response(null, { status: 204 }); }
    const bytes = objects.get(url);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(method === "HEAD" ? null : new Uint8Array(bytes).buffer, { status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), etag: '"comment-test"' } });
  };
}
