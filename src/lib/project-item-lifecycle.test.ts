import { describe, expect, it } from "vitest";
import { projectTestSnapshot } from "../project-test-fixture";
import { projectItemLifecycleRevisionHasAdvanced } from "./project-item-lifecycle";

describe("Project item lifecycle revision fences", () => {
  const input = { expectedItemRevision: 1, expectedContentRevision: 1, operationId: "remove-original" };

  it("requires an existing item and a revision compared by the original request", () => {
    const snapshot = projectTestSnapshot();
    expect(projectItemLifecycleRevisionHasAdvanced(snapshot, "missing", input, "remove")).toBe(false);
    expect(projectItemLifecycleRevisionHasAdvanced(snapshot, "item-note", input, "remove")).toBe(false);
    const item = snapshot.items.find((candidate) => candidate.id === "item-note")!;
    const content = snapshot.contents.find((candidate) => candidate.id === item.projectContentId)!;
    content.revision += 1;
    expect(projectItemLifecycleRevisionHasAdvanced(snapshot, item.id, input, "remove")).toBe(true);
    expect(projectItemLifecycleRevisionHasAdvanced(snapshot, item.id, {
      expectedItemRevision: input.expectedItemRevision, operationId: input.operationId,
    }, "remove")).toBe(false);
    item.revision += 1;
    expect(projectItemLifecycleRevisionHasAdvanced(snapshot, item.id, input, "restore")).toBe(true);
  });

  it("keeps the original deletion pending for its acknowledgement and Undo identity", () => {
    const snapshot = projectTestSnapshot();
    const item = snapshot.items.find((candidate) => candidate.id === "item-reference")!;
    item.deletedAt = "2026-09-12T19:00:00Z";
    item.revision += 1;
    item.deletionOperationId = input.operationId;
    expect(projectItemLifecycleRevisionHasAdvanced(snapshot, item.id, input, "remove")).toBe(false);
    item.deletionOperationId = "another-removal";
    expect(projectItemLifecycleRevisionHasAdvanced(snapshot, item.id, input, "remove")).toBe(true);
  });
});
