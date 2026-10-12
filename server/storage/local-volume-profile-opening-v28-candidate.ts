import { createLocalVolumeProfileOpeningV28, assertLocalVolumeProfileOpeningV28,
  type LocalVolumeProfileOwnerOptions, type LocalVolumeProfileOpening } from "./local-volume-profile-opening.ts";

declare const v28OpeningBrand: unique symbol;
/** This compile-time brand is backed by the original private opening registry;
 * copied objects cannot satisfy the actual identity/native/catalog owner. */
export interface LocalVolumeProfileOpeningV28Candidate extends LocalVolumeProfileOpening {
  readonly [v28OpeningBrand]: true;
}
export function createLocalVolumeProfileOpeningV28Candidate(options: LocalVolumeProfileOwnerOptions & {
  authentication: object;
}): LocalVolumeProfileOpeningV28Candidate {
  return createLocalVolumeProfileOpeningV28(options) as LocalVolumeProfileOpeningV28Candidate;
}
export function ownedLocalVolumeProfileContextV28Candidate(opening: LocalVolumeProfileOpeningV28Candidate) {
  return assertLocalVolumeProfileOpeningV28(opening);
}
