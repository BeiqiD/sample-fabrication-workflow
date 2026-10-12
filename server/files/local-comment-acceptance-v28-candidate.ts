import { HTTPException } from "hono/http-exception";
import type { ReviewedInstallationAdmission } from "../migrations";
import type { LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { createLocalCommentPermissionV28Candidate, ownedLocalCommentPermissionV28Candidate,
  type LocalCommentPermissionV28Candidate } from "./local-comment-permission-v28-candidate";
import { createLocalUploadExecutionV28Candidate } from "./local-upload-execution";
import { invokeLocalCommentAcceptanceRequest } from "./local-comment-acceptance";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { ownedLocalVolumeProfileContextV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";

/** Actual canonical acceptance uses the complete original six algorithms and
 * the same exact provider/body/native/source cleanup chain. Only this new V28
 * all-target Request owner can issue its additional same-BEGIN permission. No
 * route, activation, default Group policy or synthetic receipt is added here. */
export function createLocalCommentAcceptanceV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; authentication: object; admission: ReviewedInstallationAdmission;
}) {
  const { opening, authentication, admission } = options;
  const permissions = createLocalCommentPermissionV28Candidate(options);
  const physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  const consumed = new WeakSet<LocalCommentPermissionV28Candidate>();
  const retained = new Set<ReturnType<typeof createLocalUploadExecutionV28Candidate>>();
  const captures = new Set<Promise<LocalCommentPermissionV28Candidate>>();
  let closing: Promise<void> | undefined, closed = false;
  return Object.freeze({ capture(request: Request) {
      if (closed) return Promise.reject(new HTTPException(403, { message: "The original Comment owner has closed." }));
      const original = physical.writerLease.withWriter(() => permissions.captureAcceptance(request));
      captures.add(original); original.then(() => captures.delete(original), () => captures.delete(original)); return original;
    },
    async perform(request: Request, token: LocalCommentPermissionV28Candidate) {
      if (closed || consumed.has(token)) throw new HTTPException(403, { message: "The original Comment request was already consumed." });
      const actor = permissions.actor(request, token);
      ownedLocalCommentPermissionV28Candidate(token, opening, request, actor); consumed.add(token);
      const scope = createLocalUploadExecutionV28Candidate({ opening, authentication, admission, request, actor, permission: token });
      retained.add(scope);
      const original = scope.run(execution => invokeLocalCommentAcceptanceRequest(execution, opening, request, actor));
      // Normal business rejection follows proven original cleanup in this exact
      // shared execution. A typed failed body/provider/native cleanup remains
      // strongly retained with its cached first disposer outcome.
      scope.settled.then(() => retained.delete(scope), error => {
        if (!(error instanceof StorageProfileCleanupError)) retained.delete(scope);
      });
      return original;
    },
    close() {
      if (closing) return closing; closed = true;
      // Already admitted original invocations retain current authorization while
      // the parent waits their first provider/body/source ACK. Only then discard.
      closing = (async () => {
        await Promise.allSettled([...captures]);
        await Promise.all([...retained].map(scope => scope.dispose())); permissions.discard();
      })();
      closing.then(() => undefined, () => undefined); return closing;
    },
  });
}
