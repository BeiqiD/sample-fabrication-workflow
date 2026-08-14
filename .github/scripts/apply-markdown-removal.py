from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new, 1))


# Reading exposes the same recoverable Project-item lifecycle operation as Map.
replace_once(
    "src/components/project/ProjectReadingSurface.tsx",
    '''  onMarkdownEditRequest?: (itemId: string) => void;\n  onMarkdownChange?: (value: string) => void;''',
    '''  onMarkdownEditRequest?: (itemId: string) => void;\n  onMarkdownDeleteRequest?: (itemId: string) => void;\n  onMarkdownChange?: (value: string) => void;''',
)
replace_once(
    "src/components/project/ProjectReadingSurface.tsx",
    '''  onMarkdownEditRequest,\n  onMarkdownChange,''',
    '''  onMarkdownEditRequest,\n  onMarkdownDeleteRequest,\n  onMarkdownChange,''',
)
replace_once(
    "src/components/project/ProjectReadingSurface.tsx",
    '''          <button\n            type="button"\n            className="button reading-edit-button"\n            disabled={interactionDisabled || editorBusy}\n            onClick={() => onMarkdownEditRequest?.(node.itemId)}\n          >Edit Markdown</button>''',
    '''          <div className="project-owned-content-pending-actions">\n            <button\n              type="button"\n              className="button reading-edit-button"\n              disabled={interactionDisabled || editorBusy}\n              onClick={() => onMarkdownEditRequest?.(node.itemId)}\n            >Edit Markdown</button>\n            <button\n              type="button"\n              className="button reading-edit-button"\n              disabled={interactionDisabled || editorBusy}\n              onClick={() => onMarkdownDeleteRequest?.(node.itemId)}\n            >Move Markdown to trash</button>\n          </div>''',
)

# The existing generic backend lifecycle route already deletes the item,
# placement, edges and owned content atomically. Wire Markdown to it with both
# item and content revisions and remove the deleted records from local state.
replace_once(
    "src/pages/ProjectPage.tsx",
    '''    setSnapshot((current) => current ? {\n      ...current,\n      project: result.project,\n      items: current.items.filter((item) => item.id !== itemId),\n      placements: current.placements.filter((placement) => placement.projectItemId !== itemId),\n      edges: current.edges.filter((edge) => edge.sourceItemId !== itemId && edge.targetItemId !== itemId),\n    } : current);''',
    '''    setSnapshot((current) => {\n      if (!current) return current;\n      const removedContentId = result.content?.id\n        ?? current.items.find((item) => item.id === itemId)?.projectContentId\n        ?? null;\n      return {\n        ...current,\n        project: result.project,\n        contents: removedContentId\n          ? current.contents.filter((content) => content.id !== removedContentId)\n          : current.contents,\n        attachments: removedContentId\n          ? current.attachments.filter((attachment) => attachment.projectContentId !== removedContentId)\n          : current.attachments,\n        items: current.items.filter((item) => item.id !== itemId),\n        placements: current.placements.filter((placement) => placement.projectItemId !== itemId),\n        edges: current.edges.filter((edge) => edge.sourceItemId !== itemId && edge.targetItemId !== itemId),\n      };\n    });''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''    setSaveError("");\n    setReferenceActionError("");\n    clearReferenceRemoval();''',
    '''    setSaveError("");\n    setReferenceActionError("");\n    setOwnedContentActionError("");\n    clearReferenceRemoval();''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const startReferenceRemoval = useCallback((itemId: string, expectedItemRevision: number) => {\n    if (pendingReferenceRemovalRef.current) return;\n    const input: ProjectItemLifecycleInput = {\n      expectedItemRevision,\n      operationId: createProjectApiId("operation"),\n    };''',
    '''  const startReferenceRemoval = useCallback((\n    itemId: string,\n    expectedItemRevision: number,\n    expectedContentRevision?: number,\n  ) => {\n    if (pendingReferenceRemovalRef.current) return;\n    const input: ProjectItemLifecycleInput = {\n      expectedItemRevision,\n      ...(expectedContentRevision === undefined ? {} : { expectedContentRevision }),\n      operationId: createProjectApiId("operation"),\n    };''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const removeSelectedReference = useCallback(() => {\n    if (!snapshot || !selectedItem || selectedItem.itemType !== "reference"\n      || saveStateRef.current !== "saved" || pendingReferenceRef.current || pendingReferenceRemovalRef.current\n      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current\n      || edgeController.unsafeRef.current) return;\n    startReferenceRemoval(selectedItem.id, selectedItem.revision);\n  }, [selectedItem, snapshot, startReferenceRemoval]);\n''',
    '''  const removeSelectedReference = useCallback(() => {\n    if (!snapshot || !selectedItem || selectedItem.itemType !== "reference"\n      || saveStateRef.current !== "saved" || pendingReferenceRef.current || pendingReferenceRemovalRef.current\n      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current\n      || edgeController.unsafeRef.current) return;\n    startReferenceRemoval(selectedItem.id, selectedItem.revision);\n  }, [selectedItem, snapshot, startReferenceRemoval]);\n\n  const removeMarkdownItem = useCallback((itemId: string) => {\n    if (!snapshot || saveStateRef.current !== "saved"\n      || pendingReferenceRef.current || pendingReferenceRemovalRef.current\n      || markdownEditorRef.current || pendingAttachmentRef.current || attachmentEditorRef.current\n      || edgeController.unsafeRef.current) return;\n    const item = snapshot.items.find((candidate) => candidate.id === itemId);\n    const content = item?.projectContentId\n      ? snapshot.contents.find((candidate) => candidate.id === item.projectContentId)\n      : null;\n    if (!item || item.itemType !== "content" || !content || content.contentType !== "markdown") return;\n    setSelectedItemId(item.id);\n    startReferenceRemoval(item.id, item.revision, content.revision);\n  }, [snapshot, startReferenceRemoval]);\n''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''          {selected.kind === "markdown" && <button\n            type="button"\n            className="button wide"\n            disabled={workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}\n            onClick={() => startMarkdownEdit(selected.itemId)}\n          >Edit Markdown</button>}''',
    '''          {selected.kind === "markdown" && <button\n            type="button"\n            className="button wide"\n            disabled={workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}\n            onClick={() => startMarkdownEdit(selected.itemId)}\n          >Edit Markdown</button>}\n          {selected.kind === "markdown" && <button\n            type="button"\n            className="button wide"\n            disabled={saveState !== "saved" || workspaceOperationBusy || Boolean(pendingReference) || Boolean(pendingReferenceRemoval)}\n            onClick={() => removeMarkdownItem(selected.itemId)}\n          >{pendingReferenceRemoval?.itemId === selected.itemId\n            ? pendingReferenceRemoval.status === "removing"\n              ? "Moving Markdown…"\n              : pendingReferenceRemoval.status === "reconciling"\n                ? "Reconciling removal…"\n                : pendingReferenceRemoval.status === "uncertain"\n                  ? "Removal needs exact retry"\n                  : "Removal needs reconciliation"\n            : "Move Markdown to trash"}</button>}''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''        onMarkdownEditRequest={startMarkdownEdit}\n        onMarkdownChange={changeMarkdown}''',
    '''        onMarkdownEditRequest={startMarkdownEdit}\n        onMarkdownDeleteRequest={removeMarkdownItem}\n        onMarkdownChange={changeMarkdown}''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      onMarkdownEditRequest={startMarkdownEdit}\n      onMarkdownChange={changeMarkdown}''',
    '''      onMarkdownEditRequest={startMarkdownEdit}\n      onMarkdownDeleteRequest={removeMarkdownItem}\n      onMarkdownChange={changeMarkdown}''',
)

# Mounted coverage proves Reading sends both revisions and removes the item from
# the active projection after the soft-delete response.
test_path = Path("src/project-reading.mount.test.tsx")
test_text = test_path.read_text()
insert_at = test_text.rfind("\n});")
if insert_at < 0:
    raise SystemExit("src/project-reading.mount.test.tsx: final describe closure not found")
markdown_test = r'''

  it("moves existing Markdown to trash with item and content revision guards", async () => {
    const snapshot = snapshotWithAttachment();
    const item = snapshot.items.find((candidate) => candidate.projectContentId === "content-note")!;
    const content = snapshot.contents.find((candidate) => candidate.id === "content-note")!;
    const placement = snapshot.placements.find((candidate) => candidate.projectItemId === item.id)!;
    const deletedAt = "2026-08-14T18:30:00.000Z";
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === `/api/projects/project-a/items/${item.id}` && init?.method === "DELETE") {
        return jsonResponse({
          project: { ...snapshot.project, revision: snapshot.project.revision + 1, updatedAt: deletedAt },
          item: { ...item, revision: item.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
          content: { ...content, revision: content.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
          attachment: null,
          placement,
          replayed: false,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move Markdown to trash" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe(`/api/projects/project-a/items/${item.id}`);
    expect(request[1]?.method).toBe("DELETE");
    const body = JSON.parse(String(request[1]?.body));
    expect(body).toMatchObject({
      expectedItemRevision: item.revision,
      expectedContentRevision: content.revision,
    });
    expect(body.operationId).toEqual(expect.any(String));
    await waitFor(() => {
      expect(document.querySelector(".project-reading-markdown-source")).toBeNull();
      expect(screen.queryByRole("button", { name: "Move Markdown to trash" })).toBeNull();
    });
  });
'''
test_path.write_text(test_text[:insert_at] + markdown_test + test_text[insert_at:])
