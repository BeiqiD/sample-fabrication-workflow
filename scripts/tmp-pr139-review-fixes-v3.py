from pathlib import Path

path = Path("src/project-edges.mount.test.tsx")
text = path.read_text()
old = r'''  it("keeps edge-history undo and redo available while a placement save is in flight", async () => {
    const snapshot = snapshotWithEdge();
    const placement = snapshot.placements.find((candidate) => candidate.id === "placement-note")!;
    let resolvePlacement!: (response: Response) => void;
    const placementResponse = new Promise<Response>((resolve) => {
      resolvePlacement = resolve;
    });
    const lifecycle: string[] = [];
    let savedGeometry = { x: 42, y: 40, width: 250, height: 180, zIndex: 0 };

    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a/placements/placement-note" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body)) as { geometry: typeof savedGeometry };
        savedGeometry = input.geometry;
        return placementResponse;
      }
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "DELETE") {
        lifecycle.push("DELETE");
        const revision = lifecycle.length === 1 ? 2 : 4;
        return jsonResponse({
          value: edgeRecord({ revision, deletedAt: "2026-08-13T12:00:00.000Z", deletedBy: "user@example.com" }),
          replayed: false,
        });
      }
      if (String(path) === "/api/projects/project-a/edges/edge-a/restore" && init?.method === "POST") {
        lifecycle.push("RESTORE");
        return jsonResponse({ value: edgeRecord({ revision: 3 }), replayed: false });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Move node fixture" }));
    await screen.findByText("Unsaved");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saving");

    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete edge" }));
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());
    expect(screen.getByText("Saving")).toBeTruthy();

    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());
    expect(screen.getByText("Saving")).toBeTruthy();

    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(redo);
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());
    expect(lifecycle).toEqual(["DELETE", "RESTORE", "DELETE"]);
    expect(screen.getByText("Saving")).toBeTruthy();

    resolvePlacement(new Response(JSON.stringify({
      value: {
        ...placement,
        ...savedGeometry,
        revision: placement.revision + 1,
        updatedAt: "2026-08-14T09:30:00.000Z",
      },
      replayed: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await screen.findByText("Saved");
  });
'''
new = r'''  it("keeps edge-history undo and redo available while a placement save is in flight", async () => {
    const snapshot = projectTestSnapshot();
    const placement = snapshot.placements.find((candidate) => candidate.id === "placement-note")!;
    let resolvePlacement!: (response: Response) => void;
    const placementResponse = new Promise<Response>((resolve) => {
      resolvePlacement = resolve;
    });
    const lifecycle: string[] = [];
    let edgeId = "";
    let savedGeometry = { x: 42, y: 40, width: 250, height: 180, zIndex: 0 };

    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a/placements/placement-note" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body)) as { geometry: typeof savedGeometry };
        savedGeometry = input.geometry;
        return placementResponse;
      }
      if (String(path) === "/api/projects/project-a/edges" && init?.method === "POST") {
        const input = JSON.parse(String(init.body)) as CreateProjectEdgeInput;
        edgeId = input.edgeId;
        lifecycle.push("CREATE");
        return jsonResponse({
          value: edgeRecord({
            id: edgeId,
            sourceItemId: input.sourceItemId,
            targetItemId: input.targetItemId,
            sourceHandle: input.sourceHandle,
            targetHandle: input.targetHandle,
            markerStart: input.markerStart,
            markerEnd: input.markerEnd,
            label: input.label,
          }),
          replayed: false,
        }, 201);
      }
      if (edgeId && String(path) === `/api/projects/project-a/edges/${edgeId}` && init?.method === "DELETE") {
        lifecycle.push("DELETE");
        return jsonResponse({
          value: edgeRecord({
            id: edgeId,
            revision: 2,
            deletedAt: "2026-08-13T12:00:00.000Z",
            deletedBy: "user@example.com",
          }),
          replayed: false,
        });
      }
      if (edgeId && String(path) === `/api/projects/project-a/edges/${edgeId}/restore` && init?.method === "POST") {
        lifecycle.push("RESTORE");
        return jsonResponse({ value: edgeRecord({ id: edgeId, revision: 3 }), replayed: false });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await waitForMap();
    fireEvent.click(screen.getByRole("button", { name: "Move node fixture" }));
    await screen.findByText("Unsaved");
    fireEvent.click(screen.getByRole("button", { name: "Connect edge fixture" }));
    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saving");

    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());
    expect(screen.getByText("Saving")).toBeTruthy();

    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo.hasAttribute("disabled")).toBe(false);
    fireEvent.click(redo);
    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());
    expect(lifecycle).toEqual(["CREATE", "DELETE", "RESTORE"]);
    expect(screen.getByText("Saving")).toBeTruthy();

    resolvePlacement(new Response(JSON.stringify({
      value: {
        ...placement,
        ...savedGeometry,
        revision: placement.revision + 1,
        updatedAt: "2026-08-14T09:30:00.000Z",
      },
      replayed: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await screen.findByText("Saved");
  });
'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one saving-history regression to replace, found {count}")
path.write_text(text.replace(old, new, 1))
