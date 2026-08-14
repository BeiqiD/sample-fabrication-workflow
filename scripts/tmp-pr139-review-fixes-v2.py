from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const undoDisabled = !undoCommand
    || saveState === "saving"
    || geometryInteractionDisabled
    || (undoCommand.kind !== "geometry" && edgeController.interactionDisabled);
  const redoDisabled = !redoCommand
    || saveState === "saving"
    || geometryInteractionDisabled
    || (redoCommand.kind !== "geometry" && edgeController.interactionDisabled);
''',
    '''  const undoDisabled = !undoCommand
    || (undoCommand.kind === "geometry" && saveState === "saving")
    || geometryInteractionDisabled
    || (undoCommand.kind !== "geometry" && edgeController.interactionDisabled);
  const redoDisabled = !redoCommand
    || (redoCommand.kind === "geometry" && saveState === "saving")
    || geometryInteractionDisabled
    || (redoCommand.kind !== "geometry" && edgeController.interactionDisabled);
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''      if (caught instanceof ProjectApiError && caught.status === 409) {
        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = false;
        setProjectDeleteUncertain(false);
        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");
''',
    '''      if (caught instanceof ProjectApiError && caught.status === 409) {
        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = false;
        setProjectDeleteUncertain(false);
        setProjectDeleteConfirmation("");
        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");
''',
)

edge_test = r'''
  it("keeps edge-history undo and redo available while a placement save is in flight", async () => {
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
replace_once(
    "src/project-edges.mount.test.tsx",
    '  it("undoes and redoes a committed edge deletion through authoritative restore and delete revisions", async () => {\n',
    edge_test + '  it("undoes and redoes a committed edge deletion through authoritative restore and delete revisions", async () => {\n',
)

delete_test = r'''

  it("requires a fresh title confirmation and lifecycle identity after a deletion conflict", async () => {
    const initial = projectTestSnapshot();
    const refreshed = projectTestSnapshot();
    refreshed.project = {
      ...refreshed.project,
      revision: initial.project.revision + 1,
      updatedAt: "2026-08-14T09:40:00.000Z",
    };
    let readCount = 0;
    const deleteInputs: Array<{ expectedRevision: number; operationId: string }> = [];

    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) {
        readCount += 1;
        return jsonResponse(readCount === 1 ? initial : refreshed);
      }
      if (String(path) === "/api/projects/project-a" && init?.method === "DELETE") {
        const input = JSON.parse(String(init.body)) as { expectedRevision: number; operationId: string };
        deleteInputs.push(input);
        if (deleteInputs.length === 1) return jsonResponse({ error: "Project revision conflict" }, 409);
        return jsonResponse({
          project: {
            ...refreshed.project,
            revision: refreshed.project.revision + 1,
            deletedAt: "2026-08-14T09:45:00.000Z",
            deletedBy: "user@example.com",
          },
          replayed: false,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Project Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: initial.project.title },
    });
    let dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    expect(await screen.findByText(/latest authoritative state has been reloaded/)).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByLabelText("Type the Project title to confirm") as HTMLInputElement).value).toBe("");
    });
    dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    expect(within(dialog).getByRole("button", { name: "Move to trash" }).hasAttribute("disabled")).toBe(true);
    expect(deleteInputs).toHaveLength(1);
    expect(deleteInputs[0].expectedRevision).toBe(initial.project.revision);

    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: refreshed.project.title },
    });
    dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    const freshConfirm = within(dialog).getByRole("button", { name: "Move to trash" });
    expect(freshConfirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(freshConfirm);

    await screen.findByText("Projects destination");
    expect(deleteInputs).toHaveLength(2);
    expect(deleteInputs[1].expectedRevision).toBe(refreshed.project.revision);
    expect(deleteInputs[1].operationId).not.toBe(deleteInputs[0].operationId);
  });
'''
replace_once(
    "src/project-deletion.mount.test.tsx",
    '''    const secondBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(secondBody).toEqual(firstBody);
  });
});
''',
    '''    const secondBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(secondBody).toEqual(firstBody);
  });''' + delete_test + '''
});
''',
)
