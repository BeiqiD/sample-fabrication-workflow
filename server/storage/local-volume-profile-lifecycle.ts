import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyStoredBytes } from "../../worker/files/byte-verification";
import { writeVerifiedBytes } from "../../worker/files/byte-writer";
import { createOwnedLocalProfileRegistrationSql } from "./local-profile-registration-sql";
import { openLocalByteStorage } from "./local-byte-storage";
import { nodeSha256 } from "./node-sha256";
import { ownedLocalVolumeProfileContext, type LocalVolumeProfileOpening } from "./local-volume-profile-opening";

export interface ProbeAndBindLocalVolumeInput {
  readonly operationId: string;
  readonly checkId: string;
  readonly volumeDescriptorId: string;
  readonly access: "read_only" | "read_write";
  readonly expectedBindingRevision: number | null;
}
export interface LocalVolumeAdmissionReceipt {
  readonly operationId: string;
  readonly storageProfileId: string;
  readonly checkId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly admittedAccess: "read_only" | "read_write";
  readonly createdAt: string;
  /** Historical receipt, never a current physical provider capability. */
  readonly installationId: string;
}
export interface LocalVolumeActionInput {
  readonly operationId: string;
  readonly volumeDescriptorId: string;
  readonly expectedBindingRevision: number | null;
}
export interface LocalVolumeActionReceipt {
  readonly operationId: string;
  readonly storageProfileId: string;
  readonly action: "activate" | "retire";
  readonly admissionOperationId: string | null;
  readonly bindingRevision: number;
  readonly createdAt: string;
}
export interface LocalVolumeDetachInput {
  readonly volumeDescriptorId: string;
  readonly expectedBindingRevision: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function unavailable(): never { throw new Error("Local volume admission is unavailable"); }
function checked(raw: unknown): Readonly<ProbeAndBindLocalVolumeInput> {
  const keys = ["operationId", "checkId", "volumeDescriptorId", "access", "expectedBindingRevision"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(raw, key))) unavailable();
  const value = raw as Record<string, unknown>, operationId = value.operationId, checkId = value.checkId,
    volumeDescriptorId = value.volumeDescriptorId, access = value.access, expectedBindingRevision = value.expectedBindingRevision;
  if (typeof operationId !== "string" || !UUID.test(operationId) || typeof checkId !== "string" || !UUID.test(checkId)
    || typeof volumeDescriptorId !== "string" || !UUID.test(volumeDescriptorId) || (access !== "read_only" && access !== "read_write")
    || expectedBindingRevision !== null && (!Number.isSafeInteger(expectedBindingRevision) || Number(expectedBindingRevision) < 1)) unavailable();
  return Object.freeze({ operationId, checkId, volumeDescriptorId, access: access as "read_only" | "read_write", expectedBindingRevision: expectedBindingRevision as number | null });
}
function checkedAction(raw: unknown): Readonly<LocalVolumeActionInput> {
  const keys = ["operationId", "volumeDescriptorId", "expectedBindingRevision"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(raw, key))) unavailable();
  const value = raw as Record<string, unknown>, operationId = value.operationId,
    volumeDescriptorId = value.volumeDescriptorId, expectedBindingRevision = value.expectedBindingRevision;
  if (typeof operationId !== "string" || !UUID.test(operationId) || typeof volumeDescriptorId !== "string" || !UUID.test(volumeDescriptorId)
    || expectedBindingRevision !== null && (!Number.isSafeInteger(expectedBindingRevision) || Number(expectedBindingRevision) < 1)) unavailable();
  return Object.freeze({ operationId, volumeDescriptorId, expectedBindingRevision: expectedBindingRevision as number | null });
}
function checkedDetach(raw: unknown): Readonly<LocalVolumeDetachInput> {
  const keys = ["volumeDescriptorId", "expectedBindingRevision"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(raw, key))) unavailable();
  const value = raw as Record<string, unknown>, volumeDescriptorId = value.volumeDescriptorId, expectedBindingRevision = value.expectedBindingRevision;
  if (typeof volumeDescriptorId !== "string" || !UUID.test(volumeDescriptorId)
    || !Number.isSafeInteger(expectedBindingRevision) || Number(expectedBindingRevision) < 1) unavailable();
  return Object.freeze({ volumeDescriptorId, expectedBindingRevision: Number(expectedBindingRevision) });
}

/** Own one actual finite disk probe before a binding is admitted. Read-only
 * means business reads only; operator provisioning still proves write/delete
 * and confirmed cleanup using its single owned disposable probe object. */
export function createLocalVolumeProfileLifecycle(opening: LocalVolumeProfileOpening) {
  const owner = ownedLocalVolumeProfileContext(opening);
  async function transition(raw: unknown, actor: string, action: "activate" | "retire"): Promise<LocalVolumeActionReceipt> {
    const input = checkedAction(raw);
    if (action === "activate" && input.expectedBindingRevision === null) unavailable();
    return owner.writerLease.withWriter(async () => {
      await owner.authorizeAdministrator(actor);
      const descriptor = owner.descriptor(input.volumeDescriptorId), native = owner.nativeDatabase;
      const assertHeld = () => { owner.assertAdministrator(actor); descriptor.assertCurrent(); };
      const database = createOwnedLocalProfileRegistrationSql(owner.database, { assertHeld });
      const receipt = () => {
        assertHeld();
        const row = native.prepare("SELECT * FROM local_storage_profile_activations WHERE operation_id=?").get(input.operationId);
        if (!row) return null;
        if (row.storage_profile_id !== descriptor.profileId || row.action !== action || row.configuration_revision !== 1
          || row.namespace_sha256 !== descriptor.namespaceSha256 || row.actor !== actor || !Number.isSafeInteger(row.binding_revision)
          || input.expectedBindingRevision !== null && row.binding_revision !== input.expectedBindingRevision) unavailable();
        return Object.freeze({ operationId: input.operationId, storageProfileId: descriptor.profileId, action,
          admissionOperationId: row.admission_operation_id as string | null, bindingRevision: Number(row.binding_revision), createdAt: String(row.created_at) });
      };
      const previous = receipt(); if (previous) return previous;
      const head = native.prepare(`SELECT p.namespace_identity,reg.namespace_sha256,r.state,r.activated_at,r.retired_at,
        b.binding_revision,b.admission_operation_id,b.installation_id,b.root_binding_id,b.binding_fingerprint_sha256,b.state AS binding_state,b.access,
        (SELECT max(created_at) FROM local_storage_profile_activations WHERE storage_profile_id=p.id) AS latest_action_at,
        (SELECT max(binding_revision) FROM local_storage_profile_activations WHERE storage_profile_id=p.id) AS history_revision,
        (SELECT admission_operation_id FROM local_storage_profile_activations WHERE storage_profile_id=p.id
          ORDER BY binding_revision DESC,created_at DESC,operation_id DESC LIMIT 1) AS history_admission
        FROM storage_profiles p JOIN local_storage_profile_registrations reg ON reg.storage_profile_id=p.id
        JOIN storage_profile_runtime r ON r.storage_profile_id=p.id LEFT JOIN local_storage_profile_bindings b ON b.storage_profile_id=p.id
        WHERE p.id=? AND p.adapter_type='local' AND p.configuration_source='installation' AND p.credential_reference IS NULL
          AND p.state='historical' AND p.configuration_revision=1`).get(descriptor.profileId);
      if (!head || head.namespace_identity !== descriptor.namespaceIdentity || head.namespace_sha256 !== descriptor.namespaceSha256
        || head.binding_revision !== input.expectedBindingRevision) unavailable();
      const revision = Number(head.binding_revision ?? head.history_revision ?? 0), admissionId = head.admission_operation_id ?? head.history_admission ?? null;
      if (!Number.isSafeInteger(revision) || revision < 0) unavailable();
      if (action === "activate") {
        if (head.binding_state !== "available" || head.access !== "read_write" || head.installation_id !== owner.installationId
          || head.root_binding_id !== descriptor.rootBindingId || head.binding_fingerprint_sha256 !== descriptor.bindingFingerprintSha256
          || head.history_revision !== null && Number(head.history_revision) >= revision) unavailable();
        // The reviewed runtime trigger checks the exact passed probe/admission
        // chain again inside this same native transaction. No flag-only write.
      }
      const createdAt = new Date(Math.max(Date.now(), typeof head.latest_action_at === "string" ? Date.parse(head.latest_action_at) : 0)).toISOString();
      const statements = [database.prepare(`INSERT INTO local_storage_profile_activations(operation_id,storage_profile_id,configuration_revision,action,
        admission_operation_id,binding_revision,namespace_sha256,actor,created_at) VALUES(?,?,1,?,?,?,?,?,?)`)
        .bind(input.operationId, descriptor.profileId, action, admissionId, revision, descriptor.namespaceSha256, actor, createdAt),
      action === "activate"
        ? database.prepare("UPDATE storage_profile_runtime SET state='read_write',activated_at=?,retired_at=NULL WHERE storage_profile_id=?")
          .bind(createdAt, descriptor.profileId)
        : database.prepare("UPDATE storage_profile_runtime SET state='retired',retired_at=? WHERE storage_profile_id=?")
          .bind(createdAt, descriptor.profileId)];
      try { await database.batch(statements); }
      catch { const accepted = receipt(); if (accepted) return accepted; return unavailable(); }
      const accepted = receipt(); if (!accepted) unavailable(); return accepted;
    });
  }
  return Object.freeze({
    /** Explicit audited operation; admission alone never enables a writer. */
    activate(raw: unknown, actor: string) { return transition(raw, actor, "activate"); },
    retire(raw: unknown, actor: string) { return transition(raw, actor, "retire"); },
    /** Detach only the exact current destination binding. Object bytes and
     * immutable histories remain untouched; future rebinding needs a new probe. */
    async detach(raw: unknown, actor: string): Promise<void> {
      const input = checkedDetach(raw);
      return owner.writerLease.withWriter(async () => {
        await owner.authorizeAdministrator(actor);
        const descriptor = owner.descriptor(input.volumeDescriptorId), native = owner.nativeDatabase;
        const assertHeld = () => { owner.assertAdministrator(actor); descriptor.assertCurrent(); };
        const database = createOwnedLocalProfileRegistrationSql(owner.database, { assertHeld });
        const head = native.prepare("SELECT binding_revision,state,installation_id,root_binding_id,binding_fingerprint_sha256,updated_at FROM local_storage_profile_bindings WHERE storage_profile_id=?")
          .get(descriptor.profileId);
        if (!head || head.binding_revision !== input.expectedBindingRevision || head.installation_id !== owner.installationId
          || head.root_binding_id !== descriptor.rootBindingId || head.binding_fingerprint_sha256 !== descriptor.bindingFingerprintSha256) unavailable();
        if (head.state === "detached") return;
        if (head.state !== "available") unavailable();
        // Retirement is separately audited above; detach updates only
        // destination-local state and grants no authority on a restored image.
        const now = new Date(Math.max(Date.now(), Date.parse(String(head.updated_at)))).toISOString();
        await database.batch([database.prepare("UPDATE local_storage_profile_bindings SET state='detached',updated_at=? WHERE storage_profile_id=? AND binding_revision=? AND state='available'")
          .bind(now, descriptor.profileId, input.expectedBindingRevision)]);
        assertHeld();
        const current = native.prepare("SELECT binding_revision,state FROM local_storage_profile_bindings WHERE storage_profile_id=?").get(descriptor.profileId);
        if (!current || current.binding_revision !== input.expectedBindingRevision || current.state !== "detached") unavailable();
      });
    },
    async probeAndBind(raw: unknown, actor: string): Promise<LocalVolumeAdmissionReceipt> {
      const input = checked(raw);
      return owner.writerLease.withWriter(async () => {
        await owner.authorizeAdministrator(actor);
        const descriptor = owner.descriptor(input.volumeDescriptorId), native = owner.nativeDatabase;
        const database = createOwnedLocalProfileRegistrationSql(owner.database, { assertHeld() {
          owner.assertAdministrator(actor); descriptor.assertCurrent();
        } });
        const receipt = () => {
          owner.assertAdministrator(actor); descriptor.assertCurrent();
          const row = native.prepare(`SELECT * FROM local_storage_profile_admissions WHERE operation_id=?`).get(input.operationId);
          if (!row) return null;
          if (row.storage_profile_id !== descriptor.profileId || row.check_id !== input.checkId || row.access !== input.access
            || row.installation_id !== owner.installationId || row.root_binding_id !== descriptor.rootBindingId
            || row.namespace_sha256 !== descriptor.namespaceSha256 || row.binding_fingerprint_sha256 !== descriptor.bindingFingerprintSha256
            || row.actor !== actor || !Number.isSafeInteger(row.binding_revision)
            || input.expectedBindingRevision !== null && row.binding_revision !== input.expectedBindingRevision + 1) unavailable();
          return Object.freeze({ operationId: input.operationId, storageProfileId: descriptor.profileId, checkId: input.checkId,
            bindingId: String(row.binding_id), bindingRevision: Number(row.binding_revision), admittedAccess: input.access,
            createdAt: String(row.created_at), installationId: owner.installationId });
        };
        const previous = receipt(); if (previous) return previous;
        const readHead = () => {
          owner.assertCurrent(); descriptor.assertCurrent();
          return native.prepare(`SELECT p.namespace_identity,p.configuration_revision,r.state,r.activated_at,r.retired_at,
            b.binding_revision,b.binding_id,b.admission_operation_id,b.state AS binding_state,b.updated_at,
            (SELECT coalesce(max(binding_revision),0) FROM local_storage_profile_activations WHERE storage_profile_id=p.id) AS history_revision
            FROM storage_profiles p JOIN local_storage_profile_registrations reg ON reg.storage_profile_id=p.id
            JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
            LEFT JOIN local_storage_profile_bindings b ON b.storage_profile_id=p.id
            WHERE p.id=? AND p.adapter_type='local' AND p.configuration_source='installation' AND p.credential_reference IS NULL
            AND p.state='historical' AND p.configuration_revision=1 AND p.namespace_identity=? AND reg.namespace_sha256=?`)
            .get(descriptor.profileId, descriptor.namespaceIdentity, descriptor.namespaceSha256);
        };
        // Snapshot all mutable source/old binding state before any probe await.
        const head = readHead();
        if (!head || head.binding_revision !== input.expectedBindingRevision || !Number.isSafeInteger(head.history_revision)
          || native.prepare("SELECT 1 FROM local_storage_profile_checks WHERE storage_profile_id=? AND(state='checking' OR cleanup_complete=0)").get(descriptor.profileId)) unavailable();
        const revision = Math.max(Number(head.history_revision), input.expectedBindingRevision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) unavailable();
        const bindingId = randomUUID(), createdAt = new Date().toISOString(), key = `local-profile-check/${input.checkId}`;
        const payload = randomBytes(32), sha256 = createHash("sha256").update(payload).digest("hex");
        const assertSource = () => {
          owner.assertAdministrator(actor); descriptor.assertCurrent();
          if (JSON.stringify(readHead()) !== JSON.stringify(head)) unavailable();
        };
        const capturedCheck = () => {
          assertSource();
          const row = native.prepare("SELECT * FROM local_storage_profile_checks WHERE id=?").get(input.checkId);
          if (!row || row.state !== "checking" || row.storage_profile_id !== descriptor.profileId || row.installation_id !== owner.installationId
            || row.root_binding_id !== descriptor.rootBindingId || row.binding_id !== bindingId || row.binding_revision !== revision
            || row.namespace_sha256 !== descriptor.namespaceSha256 || row.binding_fingerprint_sha256 !== descriptor.bindingFingerprintSha256
            || row.access !== input.access || row.probe_object_key !== key || row.probe_sha256 !== sha256 || row.probe_byte_size !== payload.byteLength
            || row.actor !== actor || row.created_at !== createdAt) unavailable();
        };
        assertSource();
        await database.batch([database.prepare(`INSERT INTO local_storage_profile_checks(id,storage_profile_id,configuration_revision,installation_id,root_binding_id,
          binding_id,binding_revision,namespace_sha256,binding_fingerprint_sha256,access,state,probe_object_key,probe_sha256,probe_byte_size,
          stat_verified,read_verified,write_verified,delete_verified,cleanup_complete,actor,created_at,completed_at)
          VALUES(?,?,1,?,?,?,?,?,?,?,'checking',?,?,?,0,0,0,0,0,?,?,NULL)`)
          .bind(input.checkId, descriptor.profileId, owner.installationId, descriptor.rootBindingId, bindingId, revision,
            descriptor.namespaceSha256, descriptor.bindingFingerprintSha256, input.access, key, sha256, payload.byteLength, actor, createdAt)]);
        capturedCheck();
        let bytes: Awaited<ReturnType<typeof openLocalByteStorage>> | undefined;
        const flags = { stat: 0, read: 0, write: 0, delete: 0, cleanup: 0 };
        try {
          bytes = await openLocalByteStorage(descriptor.bytes, { beforeMutation: async () => {
            capturedCheck(); await owner.authorizeAdministrator(actor); capturedCheck(); return true;
          }, assertCurrent: capturedCheck });
          capturedCheck();
          const write = { key, body: Uint8Array.from(payload).buffer, byteSize: payload.byteLength, sha256,
            contentType: "application/octet-stream", filename: "local-volume-probe" };
          try { await writeVerifiedBytes({ ...bytes, createHash: nodeSha256 }, write); flags.write = 1; flags.read = 1; }
          catch {
            // A settled PUT may have committed before its ACK was lost. One
            // fresh independent exact-key/hash read can settle this owned probe;
            // neither write retry nor speculative deletion is permitted.
            capturedCheck(); await verifyStoredBytes(bytes.reader, key, write, nodeSha256); flags.write = 1; flags.read = 1;
          }
          capturedCheck();
          const stat = await bytes.reader.stat(key);
          if (stat.outcome !== "available" || stat.byteSize !== payload.byteLength) unavailable(); flags.stat = 1;
          capturedCheck();
          const deleted = await bytes.deleter.delete(key); if (deleted.outcome !== "acknowledged") unavailable(); flags.delete = 1;
          capturedCheck();
          const absentStat = await bytes.reader.stat(key), absentRead = await bytes.reader.read(key);
          if (absentRead.outcome === "available") await absentRead.body.cancel();
          if (absentStat.outcome !== "missing" || absentRead.outcome !== "missing") unavailable(); flags.cleanup = 1;
          await owner.authorizeAdministrator(actor); capturedCheck();
          const completedAt = new Date(Math.max(Date.now(), Date.parse(createdAt))).toISOString();
          const bindingValues = [descriptor.profileId, owner.installationId, descriptor.rootBindingId, bindingId,
            revision, input.operationId, descriptor.namespaceSha256, descriptor.bindingFingerprintSha256, input.access, completedAt, completedAt];
          await database.batch([
            database.prepare(`UPDATE local_storage_profile_checks SET state='passed',stat_verified=1,read_verified=1,write_verified=1,delete_verified=1,
              cleanup_complete=1,completed_at=? WHERE id=? AND state='checking'`).bind(completedAt, input.checkId),
            database.prepare(`INSERT INTO local_storage_profile_admissions(operation_id,storage_profile_id,configuration_revision,installation_id,root_binding_id,
              binding_id,binding_revision,check_id,namespace_sha256,binding_fingerprint_sha256,access,actor,created_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)`)
              .bind(input.operationId, descriptor.profileId, owner.installationId, descriptor.rootBindingId, bindingId, revision, input.checkId,
                descriptor.namespaceSha256, descriptor.bindingFingerprintSha256, input.access, actor, completedAt),
            input.expectedBindingRevision === null
              ? database.prepare(`INSERT INTO local_storage_profile_bindings(storage_profile_id,installation_id,root_binding_id,binding_id,binding_revision,
                admission_operation_id,namespace_sha256,binding_fingerprint_sha256,access,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'available',?,?)`)
                .bind(...bindingValues)
              : database.prepare(`UPDATE local_storage_profile_bindings SET root_binding_id=?,binding_id=?,binding_revision=?,admission_operation_id=?,
                binding_fingerprint_sha256=?,access=?,state='available',updated_at=? WHERE storage_profile_id=? AND binding_revision=?`)
                .bind(descriptor.rootBindingId, bindingId, revision, input.operationId, descriptor.bindingFingerprintSha256, input.access,
                  completedAt, descriptor.profileId, input.expectedBindingRevision),
          ]);
          const accepted = receipt(); if (!accepted || accepted.bindingId !== bindingId || accepted.bindingRevision !== revision) unavailable(); return accepted;
        } catch {
          // A native COMMIT can precede a lost acknowledgement. Recover only
          // this exact attempt's immutable receipt, under current admin/owner.
          try { const accepted = receipt();
            if (accepted && accepted.bindingId === bindingId && accepted.bindingRevision === revision) return accepted;
          } catch { /* Revocation withholds receipts; terminal SQL remains intact. */ }
          // Retain failed/uncertain ownership. Recording failure grants no new
          // authority and needs no provider cleanup after admin revocation.
          owner.assertCurrent();
          const audit = createOwnedLocalProfileRegistrationSql(owner.database, { assertHeld: owner.assertCurrent });
          const completedAt = new Date(Math.max(Date.now(), Date.parse(createdAt))).toISOString();
          await audit.batch([audit.prepare(`UPDATE local_storage_profile_checks SET state='failed',stat_verified=?,read_verified=?,write_verified=?,delete_verified=?,
            cleanup_complete=?,completed_at=? WHERE id=? AND state='checking'`)
            .bind(flags.stat, flags.read, flags.write, flags.delete, flags.cleanup, completedAt, input.checkId)]);
          return unavailable();
        } finally { if (bytes) await bytes.close(); }
      });
    },
  });
}
