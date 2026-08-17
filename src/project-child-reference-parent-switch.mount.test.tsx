// @vitest-environment jsdom
import {
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
} from "react-router-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ProjectSnapshot,
} from "../shared/project-api";
import type {
  ReferenceResolution,
} from "../shared/reference-types";
import type {
  ProjectNodeDescriptor,
} from "./lib/project-map-model";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => null,
}));

vi.mock("./components/project/ProjectInspectorChildren", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ProjectInspectorChildren: ({
      parent,
    }: {
      parent: { type: string; id: string };
    }) => {
      const [mountedParent] = React.useState(parent);
      return <p data-testid="mounted-child-parent">
        {mountedParent.type}:{mountedParent.id}
      </p>;
    },
  };
});

vi.mock("./components/project/ProjectMapSurface", () => ({
  ProjectMapSurface: forwardRef(function ProjectMapSurfaceFixture({
    nodes,
    onSelect,
  }: {
    nodes: ProjectNodeDescriptor[];
    onSelect?: (itemId: string | null) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({
      getViewportCenter: () => ({ x: 500, y: 300 }),
    }));
    return <div data-testid="project-flow-canvas">
      {nodes.map((node) => <button
        type="button"
        key={node.itemId}
        onClick={() => onSelect?.(node.itemId)}
      >Select {node.title}</button>)}
    </div>;
  }),
}));

const secondParentResolution: ReferenceResolution = {
  target: { type: "sample", id: "sample-b" },
  resolution: "resolved",
  source: {
    title: "Sample B",
    subtitle: "Stored sample",
    excerpt: "A second source record",
    kind: "sample",
    state: "stored",
    updatedAt: "2026-08-11T08:00:00.000Z",
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

function twoReferenceSnapshot(): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  const referenceItem = snapshot.items.find(
    (item) => item.id === "item-reference",
  )!;
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

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], {
    initialEntries: ["/projects/project-a?focus=item-reference"],
  });
  return render(<RouterProvider router={router} />);
}

describe("Project child browser parent identity", () => {
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

  it("remounts the child browser when the selected Reference target changes", async () => {
    const snapshot = twoReferenceSnapshot();
    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (path === "/api/projects/project-a" && !init?.method) {
        return jsonResponse(snapshot);
      }
      return jsonResponse({ error: `Unexpected request: ${path}` }, 500);
    });

    renderProjectPage();
    await screen.findByTestId("project-flow-canvas");
    expect(screen.getByTestId("mounted-child-parent").textContent)
      .toBe("sample:sample-a");

    fireEvent.click(screen.getByRole("button", {
      name: "Select Sample B",
    }));
    await waitFor(() => expect(
      screen.getByTestId("mounted-child-parent").textContent,
    ).toBe("sample:sample-b"));
  });
});
