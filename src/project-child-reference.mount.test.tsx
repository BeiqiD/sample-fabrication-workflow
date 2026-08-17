// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListReferenceChildrenResponse } from "../shared/reference-children";
import type {
  CreateReferenceProjectItemInput,
  ProjectItemMutationResponse,
  ProjectSnapshot,
} from "../shared/project-api";
import type { ReferenceResolution } from "../shared/reference-types";
import type {
  ProjectNodeDescriptor,
} from "./lib/project-map-model";
import type {
  ProjectPendingReferencePlacement,
} from "./lib/project-reference-placement";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => null,
}));

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function ProjectMapSurfaceFixture({
    nodes,
    pendingReference,
    onSelect,
  }: {
    nodes: ProjectNodeDescriptor[];
    pendingReference?: ProjectPendingReferencePlacement | null;
    onSelect?: (itemId: string | null) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({
      getViewportCenter: () => ({ x: 500, y: 300 }),
    }));
    return <div data-testid="project-flow-canvas">
      <p>Map node count: {nodes.length}</p>
      {nodes.map((node) => <button
        type="button"
        key={node.itemId}
        onClick={() => onSelect?.(node.itemId)}
      >Select {node.title}</button>)}
      {pendingReference && <p>
        Pending child: {pendingReference.status} · {pendingReference.preview.title}
      </p>}
    </div>;
  }),
}));

const childResolution: ReferenceResolution = {
  target: { type: "run", id: "reference-run-a" },
  resolution: "resolved",
  source: {
    title: "Reference process v3",
    subtitle: "REF-A · Reference sample A",
    excerpt: null,
    kind: "process",
    state: "active",
    updatedAt: "2026-08-01T01:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
  },
  contexts: [{
    segments: [{
      type: "sample",
      id: "reference-sample-a",
      label: "REF-A · Reference sample A",
      deletedAt: null,
      archivedAt: null,
    }, {
      type: "run",
      id: "reference-run-a",
      label: "Reference process v3",
      deletedAt: null,
      archivedAt: null,
    }],
  }],
  destination: {
    referenceUrl: "/references/run/r1_reference-run-a",
    mode: "source",
    openSourceUrl: "/processing/reference-sample-a?run=reference-run-a",
    contextOpenSourceUrls: ["/processing/reference-sample-a?run=reference-run-a"],
  },
};

const secondParentResolution: ReferenceResolution = {
  target: { type: "sample", id: "sample-b" },
  resolution: "resolved",
  source: {
    title: "Sample B",
    subtitle: "Stored sample",
    excerpt: "A second source record",
    kind: "sample",
    state: "stored",
    updatedAt: "2026-08-01T01:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
  },
  contexts: [],
  destination: {
    referenceUrl: "/references/sample/r1_sample-b",
    mode: "source",
    openSourceUrl: "/samples/sample-b",
    contextOpenSourceUrls: ["/samples/sample-b"],
  },
};

const secondChildResolution: ReferenceResolution = {
  target: { type: "run", id: "reference-run-b" },
  resolution: "resolved",
  source: {
    title: "Reference process B",
    subtitle: "REF-B · Sample B",
    excerpt: null,
    kind: "process",
    state: "active",
    updatedAt: "2026-08-01T02:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
  },
  contexts: [{
    segments: [{
      type: "sample",
      id: "sample-b",
      label: "REF-B · Sample B",
      deletedAt: null,
      archivedAt: null,
    }, {
      type: "run",
      id: "reference-run-b",
      label: "Reference process B",
      deletedAt: null,
      archivedAt: null,
    }],
  }],
  destination: {
    referenceUrl: "/references/run/r1_reference-run-b",
    mode: "source",
    openSourceUrl: "/processing/sample-b?run=reference-run-b",
    contextOpenSourceUrls: ["/processing/sample-b?run=reference-run-b"],
  },
};

function desktopMatchMedia() {
  return vi.fn(() => ({
    matches: true,
    media: "(min-width: 860px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function insertionResponse(input: CreateReferenceProjectItemInput): ProjectItemMutationResponse {
  const snapshot = projectTestSnapshot();
  const now = "2026-08-17T10:00:00.000Z";
  return {
    item: {
      id: input.itemId,
      projectId: snapshot.project.id,
      itemType: "reference",
      projectContentId: null,
      referenceTargetId: "registry-child-run",
      createdSequence: 3,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedBy: null,
    },
    content: null,
    attachment: null,
    placement: {
      id: input.placementId,
      projectItemId: input.itemId,
      ...input.geometry,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
    },
    project: {
      ...snapshot.project,
      revision: 3,
      nextCreatedSequence: 4,
      updatedAt: now,
    },
    replayed: false,
  };
}

function projectSnapshotWithTwoReferences(): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  const referenceItem = snapshot.items.find((item) => item.id === "item-reference")!;
  const referencePlacement = snapshot.placements.find(
    (placement) => placement.projectItemId === referenceItem.id,
  )!;
  return {
    ...snapshot,
    project: {
      ...snapshot.project,
      nextCreatedSequence: 4,
    },
    items: [...snapshot.items, {
      ...referenceItem,
      id: "item-reference-b",
      referenceTargetId: "registry-sample-b",
      createdSequence: 3,
    }],
    placements: [...snapshot.placements, {
      ...referencePlacement,
      id: "placement-reference-b",
      projectItemId: "item-reference-b",
      x: 640,
      zIndex: 2,
    }],
    references: [...snapshot.references, {
      registryId: "registry-sample-b",
      resolution: secondParentResolution,
    }],
  };
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a?focus=item-reference"] });
  return render(<RouterProvider router={router} />);
}

describe("mounted authoritative child-reference insertion", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads stable direct children and reuses the existing exact placement mutation", async () => {
    const pendingInsertion = deferred<Response>();
    const snapshot = projectTestSnapshot();
    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (path === "/api/projects/project-a" && !init?.method) {
        return jsonResponse(snapshot);
      }
      if (path === "/api/references/children" && init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as {
          parent: { type: string; id: string };
        };
        const parent = input.parent.type === "sample"
          ? snapshot.references[0].resolution
          : childResolution;
        const response: ListReferenceChildrenResponse = {
          parent,
          parentEligible: true,
          children: input.parent.type === "sample" ? [childResolution] : [],
          truncated: false,
        };
        return jsonResponse(response);
      }
      if (path === "/api/projects/project-a/items/reference" && init?.method === "POST") {
        return pendingInsertion.promise;
      }
      return jsonResponse({ error: `Unexpected request: ${path}` }, 500);
    });

    renderProjectPage();
    await screen.findByTestId("project-flow-canvas");
    expect(fetchMock.mock.calls.some(([path]) => (
      String(path) === "/api/references/children"
    ))).toBe(false);
    fireEvent.click(screen.getByRole("button", {
      name: "Browse direct child references",
    }));
    const place = await screen.findByRole("button", {
      name: "Place Reference process v3 on Map",
    });

    const childRequest = fetchMock.mock.calls.find(([path]) => (
      String(path) === "/api/references/children"
    ));
    expect(childRequest).toBeTruthy();
    expect(JSON.parse(String(childRequest?.[1]?.body))).toEqual({
      parent: { type: "sample", id: "sample-a" },
    });

    fireEvent.click(place);
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => (
      String(path) === "/api/projects/project-a/items/reference"
    ))).toBe(true));
    const insertionCall = fetchMock.mock.calls.find(([path]) => (
      String(path) === "/api/projects/project-a/items/reference"
    ))!;
    const input = JSON.parse(String(insertionCall[1]?.body)) as CreateReferenceProjectItemInput;
    expect(input.target).toEqual(childResolution.target);
    expect(input.expectedProjectRevision).toBe(2);
    expect(input.geometry).toEqual({
      x: 350,
      y: 210,
      width: 300,
      height: 180,
      zIndex: 2,
    });
    expect(input.itemId).toMatch(/^item-/);
    expect(input.placementId).toMatch(/^placement-/);
    expect(input.operationId).toMatch(/^operation-/);
    expect(screen.getByText("Pending child: placing · Reference process v3")).toBeTruthy();

    pendingInsertion.resolve(new Response(JSON.stringify(insertionResponse(input)), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    await waitFor(() => expect(screen.getByText("Map node count: 3")).toBeTruthy());
    expect(screen.queryByText(/Pending child:/)).toBeNull();
  });

  it("keeps the newly selected parent authoritative when an earlier child response resolves late", async () => {
    const delayedFirstParent = deferred<Response>();
    const snapshot = projectSnapshotWithTwoReferences();
    let inserted: CreateReferenceProjectItemInput | null = null;
    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (path === "/api/projects/project-a" && !init?.method) {
        return jsonResponse(snapshot);
      }
      if (path === "/api/references/children" && init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as {
          parent: { type: string; id: string };
        };
        if (input.parent.id === "sample-a") return delayedFirstParent.promise;
        if (input.parent.id === "sample-b") {
          const response: ListReferenceChildrenResponse = {
            parent: secondParentResolution,
            parentEligible: true,
            children: [secondChildResolution],
            truncated: false,
          };
          return jsonResponse(response);
        }
      }
      if (path === "/api/projects/project-a/items/reference" && init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as CreateReferenceProjectItemInput;
        inserted = input;
        return jsonResponse(insertionResponse(input), 201);
      }
      return jsonResponse({ error: `Unexpected request: ${path}` }, 500);
    });

    renderProjectPage();
    await screen.findByTestId("project-flow-canvas");
    fireEvent.click(screen.getByRole("button", {
      name: "Browse direct child references",
    }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([request, init]) => (
      String(request) === "/api/references/children"
      && JSON.parse(String(init?.body)).parent.id === "sample-a"
    ))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Select Sample B" }));
    fireEvent.click(await screen.findByRole("button", {
      name: "Browse direct child references",
    }));
    const placeSecondChild = await screen.findByRole("button", {
      name: "Place Reference process B on Map",
    });

    const firstParentResponse: ListReferenceChildrenResponse = {
      parent: snapshot.references[0].resolution,
      parentEligible: true,
      children: [childResolution],
      truncated: false,
    };
    delayedFirstParent.resolve(new Response(JSON.stringify(firstParentResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Place Reference process v3 on Map",
    })).toBeNull());
    expect(screen.getByRole("button", {
      name: "Place Reference process B on Map",
    })).toBeTruthy();

    fireEvent.click(placeSecondChild);
    await waitFor(() => expect(inserted).not.toBeNull());
    expect((inserted as unknown as CreateReferenceProjectItemInput).target)
      .toEqual(secondChildResolution.target);
  });

});
