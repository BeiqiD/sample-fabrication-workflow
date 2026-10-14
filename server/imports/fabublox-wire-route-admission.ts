import { assertNodeRuntimeConfigurationForProfile } from "../node-runtime-config.ts";
import { assertLocalVolumeProfileOpeningV28Binding } from "../storage/local-volume-profile-opening.ts";
import { assertNodeV28SourceBarrierBinding, type createNodeV28SourceBarrier } from "../recovery/node-v28-source-barrier.ts";
import { MAX_FABUBLOX_IMPORT_BODY_BYTES } from "../../worker/imports/fabublox-payload.ts";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config.ts";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate.ts";

declare const brand:unique symbol;
/** Only a fixed wire ceiling, never authentication or File permission. */
export interface FabubloxWireRouteAdmission {readonly [brand]:true}
const issued=new WeakMap<FabubloxWireRouteAdmission,Readonly<{origin:string;maximum:number}>>();
export function createFabubloxWireRouteAdmission(configuration:LoadedNodeRuntimeConfiguration,
  opening:LocalVolumeProfileOpeningV28Candidate):FabubloxWireRouteAdmission {
  const config=assertNodeRuntimeConfiguration(configuration),physical=ownedLocalVolumeProfileContextV28Candidate(opening);
  physical.assertCurrent();
  const main=physical.nativeDatabase.prepare("PRAGMA database_list").all().filter(row=>row.name==="main");
  if(!config.enableLocalFile || config.enableLocalJobs || config.expectedInstallationId!==physical.installationId
    || main.length!==1 || main[0]?.file!==config.databasePath)throw new Error("FabuBlox wire admission is unavailable");
  const token=Object.freeze({}) as FabubloxWireRouteAdmission;
  issued.set(token,Object.freeze({origin:config.publicOrigin,maximum:MAX_FABUBLOX_IMPORT_BODY_BYTES}));return token;
}
/** Deny-only wire limit for the genuine combined parent; supplies no File grant. */
export function createFabubloxWireRouteAdmissionV28Workflow(options: {
  configuration: LoadedNodeRuntimeConfiguration; opening: LocalVolumeProfileOpeningV28Candidate;
  authentication: object; sourceBarrier: ReturnType<typeof createNodeV28SourceBarrier>;
}): FabubloxWireRouteAdmission {
  const config = assertNodeRuntimeConfigurationForProfile(options.configuration, "v28-workflow");
  const physical = ownedLocalVolumeProfileContextV28Candidate(options.opening);
  assertLocalVolumeProfileOpeningV28Binding(options.opening, physical.database, physical.nativeDatabase, physical.writerLease, options.authentication);
  assertNodeV28SourceBarrierBinding(options.sourceBarrier, physical.database, physical.nativeDatabase, physical.writerLease, options.authentication);
  const main = physical.nativeDatabase.prepare("PRAGMA database_list").all().filter(row => row.name === "main");
  if (!config.enableLocalFile || !config.enableLocalJobs || !config.enableLocalRecovery
    || config.expectedInstallationId !== physical.installationId || main.length !== 1 || main[0]?.file !== config.databasePath)
    throw new Error("FabuBlox workflow wire admission is unavailable");
  const token = Object.freeze({}) as FabubloxWireRouteAdmission;
  issued.set(token, Object.freeze({ origin: config.publicOrigin, maximum: MAX_FABUBLOX_IMPORT_BODY_BYTES })); return token;
}
export function readFabubloxWireRouteAdmission(token:FabubloxWireRouteAdmission,origin:string):number {
  const value=issued.get(token);if(!value || value.origin!==origin)throw new Error("FabuBlox wire admission is unavailable");
  return value.maximum;
}
