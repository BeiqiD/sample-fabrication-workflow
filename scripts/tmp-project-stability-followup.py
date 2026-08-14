from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one stability follow-up anchor in {path}, found {count}: {old[:140]!r}")
    target.write_text(text.replace(old, new, 1))


# Scope the lifecycle dialog confirmation button rather than the header action.
replace_once(
    "src/project-deletion.mount.test.tsx",
    'import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";',
    'import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";',
)
replace_once(
    "src/project-deletion.mount.test.tsx",
    '    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));\n\n    expect(await screen.findByText("Temporary Project deletion failure")).toBeTruthy();',
    '    const dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });\n    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));\n\n    expect(await screen.findByText("Temporary Project deletion failure")).toBeTruthy();',
)

# An authoritative Project lifecycle operation participates in the same navigation
# and responsive safety boundary as the other exact-retry mutations.
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const projectionSwitchLocked = saveState !== "saved"
    || pendingReference !== null
    || pendingReferenceRemoval !== null
    || markdownEditor !== null
    || pendingAttachment !== null
    || attachmentEditor !== null
    || edgeController.unsafe;
''',
    '''  const projectionSwitchLocked = saveState !== "saved"
    || pendingReference !== null
    || pendingReferenceRemoval !== null
    || markdownEditor !== null
    || pendingAttachment !== null
    || attachmentEditor !== null
    || deletingProject
    || projectDeleteUncertain
    || edgeController.unsafe;
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      || pendingAttachmentRef.current !== null
      || attachmentEditorRef.current !== null
      || edgeController.unsafeRef.current
  ));
''',
    '''      || pendingAttachmentRef.current !== null
      || attachmentEditorRef.current !== null
      || projectDeleteInputRef.current !== null
      || edgeController.unsafeRef.current
  ));
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      || pendingAttachment !== null
      || attachmentEditor !== null
      || edgeController.unsafe)
''',
    '''      || pendingAttachment !== null
      || attachmentEditor !== null
      || deletingProject
      || projectDeleteUncertain
      || edgeController.unsafe)
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  ), [attachmentEditor, edgeController.unsafe, markdownEditor, pendingAttachment, pendingReference, pendingReferenceRemoval, saveState]);
''',
    '''  ), [attachmentEditor, deletingProject, edgeController.unsafe, markdownEditor, pendingAttachment, pendingReference, pendingReferenceRemoval, projectDeleteUncertain, saveState]);
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      && pendingAttachmentRef.current === null
      && attachmentEditorRef.current === null
      && !edgeController.unsafeRef.current) return;
''',
    '''      && pendingAttachmentRef.current === null
      && attachmentEditorRef.current === null
      && projectDeleteInputRef.current === null
      && !edgeController.unsafeRef.current) return;
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      projectDeleteInputRef.current = null;
      setProjectDeleteUncertain(false);
      navigate("/projects", { replace: true });
''',
    '''      projectDeleteInputRef.current = null;
      setProjectDeleteUncertain(false);
      setDeletingProject(false);
      navigate("/projects", { replace: true });
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''        projectDeleteInputRef.current = null;
        setProjectDeleteUncertain(false);
        navigate("/projects", { replace: true });
''',
    '''        projectDeleteInputRef.current = null;
        setProjectDeleteUncertain(false);
        setDeletingProject(false);
        navigate("/projects", { replace: true });
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const navigationBlockMessage = edgeController.pending
''',
    '''  const navigationBlockMessage = projectDeleteUncertain
    ? "The Project trash operation outcome is uncertain. Retry the exact move before leaving this Project."
    : deletingProject
      ? "Finishing the Project trash operation before leaving this Project…"
      : edgeController.pending
''',
)

# Replace the Phase 3B4 test that encoded the old global placement-save lock.
old_test = '''  it("disables edge connection and edge-history undo while placement state is unsaved", async () => {
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshotWithEdge());
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "DELETE") {
        return jsonResponse({
          value: edgeRecord({ revision: 2, deletedAt: "2026-08-13T12:00:00.000Z", deletedBy: "user@example.com" }),
          replayed: false,
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    expect(screen.getByText("Edge interaction: enabled")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete edge" }));
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Move node fixture" }));
    await waitFor(() => expect(screen.getByText("Edge interaction: disabled")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Connect edge fixture" }).hasAttribute("disabled")).toBe(true);

    const undoGeometry = screen.getByRole("button", { name: "Undo" });
    expect(undoGeometry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(undoGeometry);

    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true));
  });
'''
new_test = '''  it("keeps edge connection and edge-history undo available while placement state is locally unsaved", async () => {
    const lifecycle: string[] = [];
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshotWithEdge());
      if (String(path) === "/api/projects/project-a/edges/edge-a" && init?.method === "DELETE") {
        lifecycle.push("DELETE");
        return jsonResponse({
          value: edgeRecord({ revision: 2, deletedAt: "2026-08-13T12:00:00.000Z", deletedBy: "user@example.com" }),
          replayed: false,
        });
      }
      if (String(path) === "/api/projects/project-a/edges/edge-a/restore" && init?.method === "POST") {
        lifecycle.push("RESTORE");
        return jsonResponse({ value: edgeRecord({ revision: 3 }), replayed: false });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });

    renderProjectPage();
    await waitForMap();
    expect(screen.getByText("Edge interaction: enabled")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select edge fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete edge" }));
    await waitFor(() => expect(screen.getByText("Edge count: 0")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Move node fixture" }));
    await waitFor(() => expect(screen.getByText("Unsaved")).toBeTruthy());
    expect(screen.getByText("Edge interaction: enabled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect edge fixture" }).hasAttribute("disabled")).toBe(false);

    const undoGeometry = screen.getByRole("button", { name: "Undo" });
    expect(undoGeometry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(undoGeometry);

    const undoEdge = await waitFor(() => {
      const button = screen.getByRole("button", { name: "Undo" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    fireEvent.click(undoEdge);
    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());
    expect(lifecycle).toEqual(["DELETE", "RESTORE"]);
  });
'''
replace_once("src/project-edges.mount.test.tsx", old_test, new_test)
