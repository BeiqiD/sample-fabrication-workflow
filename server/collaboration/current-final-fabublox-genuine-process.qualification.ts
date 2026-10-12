import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { request as nodeRequest, type IncomingMessage } from "node:http";
import { canonicalFileObject, consumeCanonicalFileClient, retainedCanonicalFileCase,
  assertCanonicalFileOwnersReleased, withCanonicalFileDatabase } from "./current-v28-canonical-comment-file.qualification-support";
import { prepareGenuineFabubloxBaseline, composeGenuineFabubloxHost, genuineWorkbook,
  originalObjectInventory, retireGenuineProfile, workbookForm, type GenuineFabubloxBaseline } from "./current-final-fabublox-genuine-process.qualification-support";

function text(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("Actual original scalar ID required"); return value; }
function template(value: unknown) { return canonicalFileObject(canonicalFileObject(canonicalFileObject(value).payload).template); }
let baseline: GenuineFabubloxBaseline | undefined;
let accepted: Readonly<{ templateId: string; familyId: string; sampleId: string; stepId: string }> | undefined;

describe.sequential("final Fabu original genuine Process and selected Local profiles", () => {
  beforeAll(() => retainedCanonicalFileCase(async () => {
    // Fresh installer/identity/profile/probe/init/stopped-enablement has the
    // original finite setup budget, separate from every business case budget.
    baseline = await prepareGenuineFabubloxBaseline(); assertCanonicalFileOwnersReleased();
  }), 20_000);

  it("verifies actual workbook bytes, restores a discarded result ACK once, preserves UUID idempotence, and locks the genuine Run through ordinary metadata and DELETE", () => retainedCanonicalFileCase(async () => {
    if (!baseline) throw new Error("Original retained setup must ACK before business");
    const b = baseline;
    await withCanonicalFileDatabase(b.path, async (owner, lease, native, core) => {
      const f = await composeGenuineFabubloxHost(owner, lease, native, core, b);
      const operator = await f.login("operator"), bob = await f.login("bob"), workbook = await genuineWorkbook();
      const emptyInternal = await originalObjectInventory(b, 0), emptyOriginals = await originalObjectInventory(b, 1);
      expect(emptyInternal).toEqual([]); expect(emptyOriginals).toEqual([]);
      expect((await f.request("/api/samples", "POST", { code: `DENIED-${randomUUID()}` }, bob)).status).toBe(403);
      const denied = await f.importRequest(workbook, randomUUID(), bob);
      expect(denied.response.status).toBe(403); await consumeCanonicalFileClient(denied.client, "text");
      expect(await originalObjectInventory(b, 1)).toEqual(emptyOriginals);

      const invalidId = randomUUID(), wrongSource = { ...canonicalFileObject(workbook.manifest.source), fileSha256: "0".repeat(64) };
      const wrong = await f.importRequest(workbook, invalidId, operator, { ...workbook.manifest, source: wrongSource });
      expect(wrong.response.status).toBe(400); await consumeCanonicalFileClient(wrong.client, "text");
      expect((await f.request(`/api/imports/fabublox/requests/${invalidId}`, "GET", undefined, operator)).status).toBe(404);
      expect(await originalObjectInventory(b, 1)).toEqual(emptyOriginals);

      const sample = await f.request("/api/samples", "POST", { code: `GENUINE-${randomUUID()}`, title: "Genuine Process Sample" }, operator);
      expect(sample.status).toBe(201); const sampleId = text(canonicalFileObject(sample.value).id);
      const requestId = randomUUID(), original = await f.importRequest(workbook, requestId, operator);
      expect(original.response.status).toBe(201);
      // A true delivered result body is deliberately discarded before JSON
      // acknowledgement. This is client result-body ACK loss, never a fake
      // publication return, replay callback or direct SQL positive witness.
      if (!original.response.body) throw new Error("Original unconsumed result body required");
      const client = original.client;
      if (client.firstCleanup || client.cancellation || client.consumption) throw new Error("Original result-body client was already selected");
      let acknowledgeCleanup!: () => void, rejectCleanup!: (error: unknown) => void;
      const firstCleanup = new Promise<void>((yes, no) => { acknowledgeCleanup = yes; rejectCleanup = no; });
      // Reserve the original client's first cleanup BEFORE invoking its one
      // actual cancellation. Protected closeClient returns this same promise,
      // including reentry/failure, and never calls Response.cancel again.
      client.firstCleanup = firstCleanup; void firstCleanup.catch(() => undefined);
      try { client.cancellation = original.response.body.cancel(); }
      catch (error) { client.cancellation = Promise.reject(error); }
      const originalCancellation = client.cancellation;
      void originalCancellation.catch(() => undefined);
      void originalCancellation.then(() => { owner.clients.delete(client); acknowledgeCleanup(); }, rejectCleanup);
      await firstCleanup; expect(client.firstCleanup).toBe(firstCleanup);
      const state = await f.request(`/api/imports/fabublox/requests/${requestId.toUpperCase()}`, "GET", undefined, operator);
      expect(state.status).toBe(200); expect(state.headers.get("cache-control")).toBe("private, no-store");
      const ready = canonicalFileObject(state.value); expect(ready.status).toBe("ready");
      const result = canonicalFileObject(ready.result), templateId = text(result.templateVersionId);
      expect(text(result.id)).toBeTruthy();
      expect((await f.request(`/api/imports/fabublox/requests/${requestId}`, "GET", undefined, bob)).status).toBe(404);
      const actualObjects = await originalObjectInventory(b, 1);
      // Original Local store places data and metadata.json in each immutable
      // object directory. Hash actual data bytes and retain every sidecar too.
      expect(actualObjects.filter(value => value.path.endsWith("/data")).map(value => value.sha256).sort())
        .toEqual([workbook.workbookSha256, workbook.manifestSha256].sort());
      expect(await originalObjectInventory(b, 0)).toEqual(emptyInternal);
      const duplicate = await f.importRequest(workbook, requestId, operator); expect(duplicate.response.status).toBe(200);
      expect(await consumeCanonicalFileClient(duplicate.client, "json")).toEqual(result);
      expect(await originalObjectInventory(b, 1)).toEqual(actualObjects);
      const different = await genuineWorkbook(), conflict = await f.importRequest(different, requestId, operator);
      expect(conflict.response.status).toBe(409); await consumeCanonicalFileClient(conflict.client, "text");
      expect(await originalObjectInventory(b, 1)).toEqual(actualObjects);

      expect((await f.request(`/api/templates/${templateId}`, "GET", undefined, bob)).status).toBe(403);
      const before = await f.request(`/api/templates/${templateId}`, "GET", undefined, operator);
      expect(before.status).toBe(200); const beforeTemplate = template(before.value), familyId = text(beforeTemplate.recipeFamilyId);
      expect(beforeTemplate).toMatchObject({ id: templateId, recipeFamilyId: familyId, sourceFilename: workbook.workbook.name, locked: false });
      expect(canonicalFileObject(beforeTemplate.initialSubstrateStep)).toMatchObject({ stepNumber: "0", name: "Substrate Stack" });
      const preview = await f.request(`/api/samples/${sampleId}/runs/preview`, "POST", { templateVersionId: templateId }, operator);
      expect(preview.status).toBe(200); const p = canonicalFileObject(preview.value); expect(p.canConfirm).toBe(true);
      const target = canonicalFileObject(p.comparisonTarget), current = canonicalFileObject(p.sampleCurrentState);
      const confirmation = { confirmed: true, expectedSampleUpdatedAt: p.sampleUpdatedAt, expectedPreviousStateHash: current.hash,
        expectedTemplateStructureKey: target.key, expectedTemplateStateHash: target.stateHash, expectedLatestRunId: p.expectedLatestRunId };
      expect((await f.request(`/api/samples/${sampleId}/runs`, "POST", { templateVersionId: templateId }, operator)).status).toBe(409);
      const started = await f.request(`/api/samples/${sampleId}/runs`, "POST", { templateVersionId: templateId, substrateConfirmation: confirmation }, operator);
      expect(started.status).toBe(201); const run = canonicalFileObject(started.value);
      expect(Object.keys(run)).toEqual(["id"]); expect(text(run.id)).toBeTruthy();
      const locked = await f.request(`/api/templates/${templateId}`, "GET", undefined, operator);
      expect(locked.status).toBe(200); const lockedTemplate = template(locked.value);
      expect(lockedTemplate).toMatchObject({ id: templateId, recipeFamilyId: familyId, locked: true }); expect(text(lockedTemplate.lockedAt)).toBeTruthy();
      if (!Array.isArray(lockedTemplate.steps) || lockedTemplate.steps.length !== 1) throw new Error("The original normal GET Step DTO required");
      const stepId = text(canonicalFileObject(lockedTemplate.steps[0]).id);
      const deletion = await f.request(`/api/templates/${templateId}/steps/${stepId}`, "DELETE", undefined, operator);
      expect(deletion.status).toBe(409);
      expect(canonicalFileObject(deletion.value).error).toBe("Only unused active template versions can be edited");
      const after = await f.request(`/api/templates/${templateId}`, "GET", undefined, operator);
      expect(after.status).toBe(200); expect(template(after.value)).toEqual(lockedTemplate);
      accepted = Object.freeze({ templateId, familyId, sampleId, stepId });
      // Parent helper consumes/cancels original clients, invokes the same first
      // application close twice, proves sole native closed, then releases lease.
    });
    assertCanonicalFileOwnersReleased();
  }), 20_000);

  it("retains the same cached application first close and sole Native parent while a genuine original multipart request is incomplete", () => retainedCanonicalFileCase(async () => {
    if (!baseline) throw new Error("Original setup ACK required");
    const b = baseline;
    await withCanonicalFileDatabase(b.path, async (owner, lease, native, core) => {
      const f = await composeGenuineFabubloxHost(owner, lease, native, core, b), operator = await f.login("operator"), workbook = await genuineWorkbook();
      // Serialize actual client FormData once. This is client byte preparation,
      // never a clone/reissued server Request or caller permission callback.
      const serialized = new Request(`${f.origin}/api/imports/fabublox`, { method: "POST", body: workbookForm(workbook) });
      const contentType = serialized.headers.get("content-type"); if (!contentType) throw new Error("Actual multipart boundary required");
      const bytes = new Uint8Array(await serialized.arrayBuffer()), cut = Math.max(1, Math.floor(bytes.byteLength / 2));
      let received!: () => void;
      const ingress = new Promise<void>(yes => { received = yes; });
      const observe = (incoming: IncomingMessage) => { if (incoming.url === "/api/imports/fabublox") {
        f.application.server.off("request", observe); received();
      } };
      f.application.server.on("request", observe);
      let delivered!: (value: { status: number; text: string }) => void, rejected!: (error: unknown) => void;
      const originalResponse = new Promise<{ status: number; text: string }>((yes, no) => { delivered = yes; rejected = no; });
      void originalResponse.catch(() => undefined);
      const original = nodeRequest(`${f.origin}/api/imports/fabublox`, { method: "POST", headers: {
        cookie: operator.cookie, origin: f.origin, "x-sfw-csrf": operator.csrf, "X-Import-Request-Id": randomUUID(),
        "content-type": contentType, "content-length": bytes.byteLength,
      } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("error", rejected); response.once("end", () => delivered({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      const originalClosed = new Promise<void>(yes => original.once("close", yes));
      original.once("error", rejected); original.setTimeout(5000, () => original.destroy(new Error("Original finite multipart client timeout")));
      let workFailed = false, workError: unknown;
      try {
        original.write(bytes.subarray(0, cut)); await Promise.race([ingress, originalResponse.then(() => { throw new Error("Incomplete ingress returned before receipt"); })]);
        const first = f.application.close(); expect(f.application.close()).toBe(first);
        let settled = false; void first.then(() => { settled = true; }, () => undefined);
        await Promise.resolve(); await Promise.resolve();
        expect(settled).toBe(false); expect(native.isOpen).toBe(true);
        original.end(bytes.subarray(cut));
        const answer = await originalResponse;
        // A request already owned before stop may finish, or original stop may
        // deny it. The tested claim is parent drain, never a synthetic201.
        expect([201, 503]).toContain(answer.status);
        await originalClosed; await first; expect(native.isOpen).toBe(false);
      } catch (error) { workFailed = true; workError = error; }
      finally {
        f.application.server.off("request", observe);
        if (workFailed) original.destroy(); // Sole original client cancellation.
        await originalClosed;
      }
      if (workFailed) throw workError;
    });
    assertCanonicalFileOwnersReleased();
  }), 20_000);

  it("uses genuine profile lifecycle receipts to ignore an unselected profile and deny the actually selected profile before metadata/start acknowledgement", () => retainedCanonicalFileCase(async () => {
    if (!baseline || !accepted) throw new Error("The first genuine HTTP fixture must ACK before selected-profile controls");
    const b = baseline, ids = accepted; let nextSample: string | undefined;
    await retireGenuineProfile(b, 0); // zero-image Fabu selects originals only.
    await withCanonicalFileDatabase(b.path, async (owner, lease, native, core) => {
      const f = await composeGenuineFabubloxHost(owner, lease, native, core, b), operator = await f.login("operator");
      const get = await f.request(`/api/templates/${ids.templateId}`, "GET", undefined, operator);
      expect(get.status).toBe(200); expect(template(get.value)).toMatchObject({ locked: true });
      const sample = await f.request("/api/samples", "POST", { code: `PROFILE-${randomUUID()}`, title: "Selected-profile source control" }, operator);
      expect(sample.status).toBe(201); nextSample = text(canonicalFileObject(sample.value).id);
      expect((await f.request(`/api/samples/${nextSample}/runs/preview`, "POST", { templateVersionId: ids.templateId }, operator)).status).toBe(200);
    });
    if (!nextSample) throw new Error("Actual second Sample ID required");
    const sourceObjects = await originalObjectInventory(b, 1), internalObjects = await originalObjectInventory(b, 0);
    await retireGenuineProfile(b, 1); // genuine audited authority change; no SQL flag injection.
    await withCanonicalFileDatabase(b.path, async (owner, lease, native, core) => {
      const f = await composeGenuineFabubloxHost(owner, lease, native, core, b), operator = await f.login("operator");
      expect((await f.request(`/api/templates/${ids.templateId}`, "GET", undefined, operator)).status).toBe(503);
      expect((await f.request(`/api/samples/${nextSample}/runs/preview`, "POST", { templateVersionId: ids.templateId }, operator)).status).toBe(503);
      // Original locked Step delete remains metadata business, not a File grant.
      expect((await f.request(`/api/templates/${ids.templateId}/steps/${ids.stepId}`, "DELETE", undefined, operator)).status).toBe(409);
      expect(await originalObjectInventory(b, 1)).toEqual(sourceObjects); expect(await originalObjectInventory(b, 0)).toEqual(internalObjects);
    });
    assertCanonicalFileOwnersReleased();
  }), 20_000);
});
