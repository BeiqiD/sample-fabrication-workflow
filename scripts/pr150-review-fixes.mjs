import { readFileSync, writeFileSync } from "node:fs";

function replaceExact(path, before, after, expectedCount = 1) {
  const source = readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`${path}: expected ${expectedCount} replacement target(s), found ${count}`);
  }
  writeFileSync(path, source.split(before).join(after));
}

replaceExact(
  "src/pages/ProjectPage.tsx",
  `function geometryIndex(snapshot: ProjectSnapshot) {
  return Object.fromEntries(snapshot.placements.map((placement) => [placement.id, {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    zIndex: placement.zIndex,
  }]));
}

function saveLabel(state: SaveState) {`,
  `function geometryIndex(snapshot: ProjectSnapshot) {
  return Object.fromEntries(snapshot.placements.map((placement) => [placement.id, {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    zIndex: placement.zIndex,
  }]));
}

function workingMaximumProjectZIndex(
  geometry: Readonly<Record<string, ProjectMapGeometry>>,
) {
  return Object.values(geometry).reduce(
    (maximum, placement) => Math.max(maximum, placement.zIndex),
    0,
  );
}

function snapshotWithPlacementProjection(
  snapshot: ProjectSnapshot,
  geometry: Readonly<Record<string, ProjectMapGeometry>>,
): ProjectSnapshot {
  let changed = false;
  const placements = snapshot.placements.map((placement) => {
    const projected = geometry[placement.id];
    if (!projected || projectGeometryEquals(placement, projected)) return placement;
    changed = true;
    return { ...placement, ...projected };
  });
  return changed ? { ...snapshot, placements } : snapshot;
}

function snapshotWithSavedPlacement(
  snapshot: ProjectSnapshot,
  placement: ProjectPlacementRecord,
): ProjectSnapshot {
  let found = false;
  const placements = snapshot.placements.map((current) => {
    if (current.id !== placement.id) return current;
    found = true;
    return placement;
  });
  return found ? { ...snapshot, placements } : snapshot;
}

function saveLabel(state: SaveState) {`,
);

replaceExact(
  "src/pages/ProjectPage.tsx",
  `        baselineRef.current = { ...baselineRef.current, [placementId]: result.value };
        delete pendingMutationRef.current[placementId];`,
  `        baselineRef.current = { ...baselineRef.current, [placementId]: result.value };
        setSnapshot((current) => current
          ? snapshotWithSavedPlacement(current, result.value)
          : current);
        delete pendingMutationRef.current[placementId];`,
);

replaceExact(
  "src/pages/ProjectPage.tsx",
  `    const maxZ = snapshot.placements.reduce((maximum, placement) => Math.max(maximum, placement.zIndex), 0);`,
  `    const maxZ = workingMaximumProjectZIndex(geometryRef.current);`,
  3,
);

replaceExact(
  "src/pages/ProjectPage.tsx",
  `      if (shortcut === "copy") {
        if (operationBlocked || saveStateRef.current !== "saved" || !snapshot || selectedItemIds.length === 0) return;
        event.preventDefault();
        copyPaste.copySelection(snapshot, selectedItemIds);
        return;
      }
      if (shortcut === "paste") {
        if (operationBlocked || saveStateRef.current !== "saved" || !snapshot) return;
        if (!copyPaste.pasteClipboard(snapshot)) return;`,
  `      if (shortcut === "copy") {
        if (operationBlocked || saveStateRef.current !== "saved" || !snapshot || selectedItemIds.length === 0) return;
        event.preventDefault();
        copyPaste.copySelection(
          snapshotWithPlacementProjection(snapshot, geometryRef.current),
          selectedItemIds,
        );
        return;
      }
      if (shortcut === "paste") {
        if (operationBlocked || saveStateRef.current !== "saved" || !snapshot) return;
        if (!copyPaste.pasteClipboard(
          snapshotWithPlacementProjection(snapshot, geometryRef.current),
        )) return;`,
);

replaceExact(
  "src/lib/project-canvas-productivity.ts",
  `function compareCanvasZOrder(
  left: ProjectCanvasGeometryEntry,
  right: ProjectCanvasGeometryEntry,
) {
  return left.geometry.zIndex - right.geometry.zIndex
    || left.itemId.localeCompare(right.itemId)
    || left.placementId.localeCompare(right.placementId);
}`,
  `function compareCanvasZOrder(
  left: ProjectCanvasGeometryEntry,
  right: ProjectCanvasGeometryEntry,
  renderOrder: ReadonlyMap<string, number>,
) {
  // React Flow resolves equal z-index values by rendered node order. The
  // entries arrive in that same order, so UUID-like identities must not
  // invent a different visual stack.
  return left.geometry.zIndex - right.geometry.zIndex
    || (renderOrder.get(left.placementId) ?? 0)
      - (renderOrder.get(right.placementId) ?? 0);
}`,
);

replaceExact(
  "src/lib/project-canvas-productivity.ts",
  `  const selectedIds = new Set(selectedItemIds);
  const sorted = [...entries].sort(compareCanvasZOrder);`,
  `  const selectedIds = new Set(selectedItemIds);
  const renderOrder = new Map(entries.map((entry, index) => [
    entry.placementId,
    index,
  ]));
  const sorted = [...entries].sort((left, right) => (
    compareCanvasZOrder(left, right, renderOrder)
  ));`,
);

replaceExact(
  "src/lib/project-canvas-productivity.test.ts",
  `  it("falls back to bounded rank reassignment at the z-index limit", () => {`,
  `  it("uses current render order to resolve duplicate z-index movement", () => {
    const duplicateEntries: ProjectCanvasGeometryEntry[] = [{
      itemId: "item-z",
      placementId: "placement-z",
      geometry: { x: 0, y: 0, width: 100, height: 100, zIndex: 0 },
    }, {
      itemId: "item-a",
      placementId: "placement-a",
      geometry: { x: 120, y: 0, width: 100, height: 100, zIndex: 0 },
    }];

    const project = (
      commands: ReturnType<typeof projectCanvasZOrderCommands>,
    ) => duplicateEntries.map((entry) => (
      commands.find((command) => command.placementId === entry.placementId)?.after
        ?? entry.geometry
    ));

    expect(project(projectCanvasZOrderCommands(
      duplicateEntries,
      ["item-z"],
      "bring-forward",
    )).map((geometry) => geometry.zIndex)).toEqual([1, 0]);

    expect(project(projectCanvasZOrderCommands(
      duplicateEntries,
      ["item-a"],
      "send-backward",
    )).map((geometry) => geometry.zIndex)).toEqual([1, 0]);

    const blockEntries: ProjectCanvasGeometryEntry[] = [
      ...duplicateEntries,
      {
        itemId: "item-top",
        placementId: "placement-top",
        geometry: { x: 240, y: 0, width: 100, height: 100, zIndex: 1 },
      },
    ];
    const blockCommands = projectCanvasZOrderCommands(
      blockEntries,
      ["item-z", "item-a"],
      "bring-to-front",
    );
    const blockZ = new Map(blockEntries.map((entry) => [
      entry.placementId,
      blockCommands.find((command) => command.placementId === entry.placementId)?.after.zIndex
        ?? entry.geometry.zIndex,
    ]));
    expect(blockZ.get("placement-z")).toBeLessThan(blockZ.get("placement-a")!);
    expect(blockZ.get("placement-a")).toBeGreaterThan(blockZ.get("placement-top")!);
  });

  it("falls back to bounded rank reassignment at the z-index limit", () => {`,
);

replaceExact(
  "src/project-canvas-productivity.mount.test.tsx",
  `      <p>{markdownEditor ? "Markdown editor active" : "Markdown editor inactive"}</p>`,
  `      <p>{markdownEditor ? "Markdown editor active" : "Markdown editor inactive"}</p>
      <p>Markdown draft z: {markdownEditor?.geometry?.zIndex ?? "none"}</p>`,
);

replaceExact(
  "src/project-canvas-productivity.mount.test.tsx",
  `  it("supports select-all, Escape, and explicit keyboard save without a bulk backend API", async () => {`,
  `  it("projects an acknowledged z-order save into subsequent Canvas creation", async () => {
    let authoritative = projectTestSnapshot();
    fetchMock.mockImplementation((request, init) => {
      if (init?.method !== "PATCH") return jsonResponse(authoritative);
      const placementId = String(request).split("/").at(-1)!;
      const body = JSON.parse(String(init.body)) as {
        geometry: ProjectNodeDescriptor["geometry"];
      };
      const current = authoritative.placements.find((candidate) => candidate.id === placementId)!;
      const value = {
        ...current,
        ...body.geometry,
        revision: current.revision + 1,
      };
      authoritative = {
        ...authoritative,
        placements: authoritative.placements.map((placement) => (
          placement.id === placementId ? value : placement
        )),
      };
      return jsonResponse({ value, replayed: false });
    });
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select note" }));
    fireEvent.click(screen.getByRole("button", { name: "Bring to front" }));
    expect(screen.getByText("Note z: 2")).toBeTruthy();
    dispatchSaveShortcut();
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Start Markdown draft" }));
    expect(screen.getByText("Markdown draft z: 3")).toBeTruthy();
  });

  it("copies acknowledged aligned geometry instead of the pre-save snapshot", async () => {
    let authoritative = projectTestSnapshot();
    const createdBodies: Record<string, any>[] = [];
    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (!init?.method || init.method === "GET") return jsonResponse(authoritative);
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      if (init.method === "PATCH") {
        const placementId = path.split("/").at(-1)!;
        const current = authoritative.placements.find((candidate) => candidate.id === placementId)!;
        const value = {
          ...current,
          ...body.geometry,
          revision: current.revision + 1,
        };
        authoritative = {
          ...authoritative,
          placements: authoritative.placements.map((placement) => (
            placement.id === placementId ? value : placement
          )),
        };
        return jsonResponse({ value, replayed: false });
      }
      if (init.method !== "POST") throw new Error(`Unexpected ${init.method} ${path}`);
      createdBodies.push(body);
      const created = createProjectItemResponse(authoritative, path, body);
      authoritative = created.next;
      return jsonResponse(created.result, 201);
    });
    renderProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Select two items" }));
    fireEvent.click(screen.getByRole("button", { name: "Align left" }));
    dispatchSaveShortcut();
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    fireEvent.keyDown(document, { key: "c", code: "KeyC", ctrlKey: true });
    fireEvent.keyDown(document, { key: "v", code: "KeyV", ctrlKey: true });

    await waitFor(() => expect(createdBodies).toHaveLength(2));
    expect(createdBodies.map((body) => body.geometry.x)).toEqual([52, 52]);
  });

  it("supports select-all, Escape, and explicit keyboard save without a bulk backend API", async () => {`,
);

replaceExact(
  "src/project-map-surface.mount.test.tsx",
  `  it("commits one grouped geometry history payload when arrow keys move multiple selected nodes", async () => {`,
  `  it("renders and clears transient alignment guides through a real drag lifecycle", async () => {
    const descriptors = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
      />
    </div>);

    const note = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    expect(container.querySelector('[data-testid="project-alignment-guide-horizontal"]')).toBeNull();

    fireEvent.mouseDown(note, {
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 100,
      view: window,
    });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 102,
      clientY: 102,
      view: window,
    });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 103,
      clientY: 103,
      view: window,
    });

    await waitFor(() => {
      expect(container.querySelector(
        '[data-testid="project-alignment-guide-horizontal"]',
      )).toBeTruthy();
    });

    fireEvent.mouseUp(window, {
      button: 0,
      buttons: 0,
      clientX: 103,
      clientY: 103,
      view: window,
    });
    await waitFor(() => {
      expect(container.querySelector(
        '[data-testid="project-alignment-guide-horizontal"]',
      )).toBeNull();
    });
  });

  it("commits one grouped geometry history payload when arrow keys move multiple selected nodes", async () => {`,
);

replaceExact(
  "docs/PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md",
  `- alignment targets remain exact while being clamped to the common persisted coordinate interval of every selected placement;
- React Flow automatic selected-node elevation is disabled so explicit z-order remains visually authoritative while a node is selected;
- ordinary cases update only selected or crossed placements, while duplicate or exhausted z-order slots use deterministic bounded rank reassignment;`,
  `- alignment targets remain exact while being clamped to the common persisted coordinate interval of every selected placement;
- successful placement PATCH responses replace the matching snapshot placement in place, preserving render order while making acknowledged geometry available to later creation and copy/paste operations;
- new Reference, Markdown, and Attachment layering reads the current working placement projection, while saved copy/paste receives the same acknowledged projection;
- equal \`zIndex\` values use current rendered-node order as the visual tie-breaker rather than UUID-like identities;
- React Flow automatic selected-node elevation is disabled so explicit z-order remains visually authoritative while a node is selected;
- ordinary cases update only selected or crossed placements, while duplicate or exhausted z-order slots use deterministic bounded rank reassignment;`,
);

replaceExact(
  "docs/PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md",
  `- boundary-safe right/center/bottom alignment near the persisted coordinate limits;
- explicit z-order remaining visible while selected;
- production build, Worker smoke, and Map bundle boundary.`,
  `- boundary-safe right/center/bottom alignment near the persisted coordinate limits;
- save-then-create and save-then-copy/paste composition over acknowledged placement geometry;
- duplicate-z forward/backward behavior matching current render order;
- a real mounted drag lifecycle that renders and clears transient guides;
- explicit z-order remaining visible while selected;
- production build, Worker smoke, and Map bundle boundary.`,
);