// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectInspectorDetails } from "./components/project/ProjectInspectorDetails";
import { projectMapNodes } from "./lib/project-map-model";
import {
  projectTestSnapshot,
  projectTestSnapshotWithAttachment,
} from "./project-test-fixture";

afterEach(cleanup);

describe("Project Inspector details", () => {
  it("renders each occurrence kind once and keeps the unavailable fallback product-facing", () => {
    const snapshot = projectTestSnapshotWithAttachment();
    const descriptors = projectMapNodes(snapshot);
    const cases = [
      ["item-note", "Project Markdown"],
      ["item-reference", "Reference"],
      ["item-attachment", "Project attachment"],
    ] as const;
    for (const [itemId, label] of cases) {
      const descriptor = descriptors.find((candidate) => candidate.itemId === itemId)!;
      const view = render(createElement(
        MemoryRouter,
        null,
        createElement(ProjectInspectorDetails, { snapshot, descriptor }),
      ));
      expect(view.container.querySelector(".meta-badge")?.textContent).toBe(label);
      expect([...view.container.querySelectorAll<HTMLElement>("*")]
        .filter((element) => element.textContent === label)).toHaveLength(1);
      if (itemId === "item-note") {
        expect(descriptor.subtitle).toBeNull();
        expect(view.container.querySelector(".card-meta")).toBeNull();
      }
      view.unmount();
    }

    const attachmentDescriptor = descriptors.find(
      (descriptor) => descriptor.itemId === "item-attachment",
    )!;
    const fallback = render(createElement(
      MemoryRouter,
      null,
      createElement(ProjectInspectorDetails, {
        snapshot,
        descriptor: { ...attachmentDescriptor, itemId: "missing-item" },
      }),
    ));
    expect(fallback.container.querySelector(".meta-badge")?.textContent)
      .toBe("Project attachment");
  });

  it("renders occurrence, relationships, provenance and exact source navigation", () => {
    const snapshot = projectTestSnapshot();
    const createdAt = snapshot.project.createdAt;
    snapshot.references[0].resolution = {
      target: { type: "execution_image", id: "execution-image-a" },
      resolution: "resolved",
      source: {
        title: "Etch endpoint",
        subtitle: "Execution image",
        excerpt: "Endpoint image from the active run",
        kind: "execution_image",
        state: "ready",
        updatedAt: createdAt,
        deletedAt: null,
        archivedAt: null,
      },
      contexts: [{
        segments: [{
          type: "sample",
          id: "sample-a",
          label: "Sample A",
          deletedAt: null,
          archivedAt: null,
        }, {
          type: "run",
          id: "run-a",
          label: "Etch run",
          deletedAt: null,
          archivedAt: null,
        }, {
          type: "run_step",
          id: "step-a",
          label: "Endpoint",
          deletedAt: null,
          archivedAt: null,
        }],
      }],
      destination: {
        referenceUrl: "/references/execution_image/r1_execution-image-a",
        mode: "source",
        openSourceUrl: "/processing/sample-a?run=run-a&step=step-a",
        contextOpenSourceUrls: ["/processing/sample-a?run=run-a&step=step-a"],
      },
    };
    snapshot.edges = [{
      id: "edge-a",
      projectId: snapshot.project.id,
      sourceItemId: "item-note",
      targetItemId: "item-reference",
      sourceHandle: "right",
      targetHandle: "left",
      markerStart: "none",
      markerEnd: "arrow",
      label: "supports",
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      deletedBy: null,
    }];
    const descriptor = projectMapNodes(snapshot)
      .find((candidate) => candidate.itemId === "item-reference")!;

    render(createElement(
      MemoryRouter,
      null,
      createElement(ProjectInspectorDetails, { snapshot, descriptor }),
    ));

    expect(screen.getByText("Reference", { selector: ".meta-badge" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Project occurrence" })).toBeTruthy();
    expect(screen.getByText("1 incoming · 0 outgoing")).toBeTruthy();
    expect(screen.getByLabelText("incoming relationship: supports; Design note")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Source & provenance" })).toBeTruthy();
    expect(screen.getByText("execution_image:execution-image-a")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Source hierarchy" })).toBeTruthy();
    expect(screen.getByText("Sample A › Etch run › Endpoint")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open exact source" }).getAttribute("href"))
      .toBe("/processing/sample-a?run=run-a&step=step-a");
    expect(screen.getByRole("link", { name: "Open exact context" }).getAttribute("href"))
      .toBe("/processing/sample-a?run=run-a&step=step-a");
  });

});
