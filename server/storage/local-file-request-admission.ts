import type { createLocalAuthentication } from "../auth/local-auth-http";
import { HTTPException } from "hono/http-exception";
import { createStorageConfigurationWriteAdmission } from "../auth/storage-configuration-write-admission";
import { AdministratorDenied } from "../../worker/storage/configuration-registry-core";
import type { ReviewedInstallationAdmission } from "../migrations";
import { createAdmittedLocalVolumeFileAuthorityDatabase, ownedLocalVolumeProfileContext,
  type LocalVolumeProfileAuthority, type LocalVolumeProfileOpening } from "./local-volume-profile-opening";
import type { NativeFileAuthoritySqlDatabase } from "../file-authority-sql";
import { asAdmittedFileAuthoritySqlDatabase } from "../file-authority-sql";

/** Trusted request-scoped composition, deliberately unmounted. Its private
 * ownership map binds the actual opening, actor and original Request. The
 * captured digest/actor is not a branded authentication proof; fresh authority
 * comes from the qualified four SELECT checks inside the actual native BEGIN. */
export interface LocalFileConfigurationRequest {
  readonly actor: string;
}
interface RequestOwner {
  readonly opening: LocalVolumeProfileOpening;
  readonly actor: string;
  authorizeAdministrator(): Promise<void>;
  database(authorities: readonly LocalVolumeProfileAuthority[]): NativeFileAuthoritySqlDatabase;
  historyDatabase(): NativeFileAuthoritySqlDatabase;
}
const requests = new WeakMap<LocalFileConfigurationRequest, RequestOwner>();

export function createLocalFileConfigurationRequest(options: {
  opening: LocalVolumeProfileOpening;
  request: Request;
  actor: string;
  admission: ReviewedInstallationAdmission;
  idleLifetimeMs: number;
  authentication: Pick<ReturnType<typeof createLocalAuthentication>, "currentSessionPredicate" | "authorize">;
}): LocalFileConfigurationRequest {
  const { opening, request, actor, admission, idleLifetimeMs } = options;
  const owner = ownedLocalVolumeProfileContext(opening);
  owner.assertCurrent(); owner.assertAdministrator(actor);
  const predicate = options.authentication.currentSessionPredicate.bind(options.authentication);
  const authorize = options.authentication.authorize.bind(options.authentication);
  // A trusted ingress composer calls this with its exact admitted Request,
  // before body work. Never parse another cookie, copy a Request, or derive
  // session authority from namespace/profile/configuration metadata.
  const session = Object.freeze({ ...predicate(request, actor) });
  const selectAdmission = createStorageConfigurationWriteAdmission({ database: owner.database,
    nativeDatabase: owner.nativeDatabase, writerLease: owner.writerLease, admission, idleLifetimeMs,
    sessionPredicate(selected, selectedActor) {
      if (selected !== request || selectedActor !== actor) throw new AdministratorDenied();
      return session;
    } });
  const captured = Object.freeze({ actor });
  const selected: RequestOwner = Object.freeze({ opening, actor,
    async authorizeAdministrator() {
      owner.assertCurrent(); owner.assertAdministrator(actor);
      if (await authorize(request, actor, "systemAdministrator") !== true) throw new AdministratorDenied();
      owner.assertCurrent(); owner.assertAdministrator(actor);
    },
    database(authorities: readonly LocalVolumeProfileAuthority[]) {
      owner.assertCurrent(); owner.assertAdministrator(actor);
      return createAdmittedLocalVolumeFileAuthorityDatabase(opening, authorities, selectAdmission(request, actor));
    },
    historyDatabase() {
      return asAdmittedFileAuthoritySqlDatabase(owner.database, selectAdmission(request, actor), {
        assertHeld() { owner.assertCurrent(); owner.assertAdministrator(actor); },
      });
    },
  });
  requests.set(captured, selected); return captured;
}

export function ownedLocalFileConfigurationRequest(request: LocalFileConfigurationRequest,
  opening: LocalVolumeProfileOpening): Readonly<RequestOwner> {
  const owner = requests.get(request);
  if (!owner || owner.opening !== opening || owner.actor !== request.actor) throw new AdministratorDenied();
  ownedLocalVolumeProfileContext(opening).assertCurrent(); return owner;
}

/** Current typed authority denial is not an uncertain accepted write. Failed
 * rollback quarantines the real core; preserve its original aggregate instead
 * of replacing it with a later receipt-read error or attempting another write. */
export function assertLocalFileRequestReconciliation(opening: LocalVolumeProfileOpening, cause: unknown): void {
  if (cause instanceof HTTPException) throw cause;
  try { ownedLocalVolumeProfileContext(opening).database.primary(); }
  catch { throw cause; }
}
