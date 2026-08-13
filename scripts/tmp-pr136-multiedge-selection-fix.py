from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}")
    if text.count(old) != 1:
        raise SystemExit(f"expected one anchor in {path}, found {text.count(old)}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "src/components/project/ProjectMapSurface.tsx",
    '''  const handleEdgesChange = useCallback((changes: EdgeChange<ProjectFlowEdge>[]) => {\n    const selection = [...changes].reverse().find((change) => change.type === "select");\n    if (!selection || selection.type !== "select") return;\n    if (selection.selected) {\n      onEdgeSelect(selection.id);\n      return;\n    }\n    if (selection.id === selectedEdgeId) onEdgeSelect(null);\n  }, [onEdgeSelect, selectedEdgeId]);''',
    '''  const handleEdgesChange = useCallback((changes: EdgeChange<ProjectFlowEdge>[]) => {\n    const selected = [...changes].reverse().find((change) => change.type === "select" && change.selected);\n    if (selected?.type === "select") {\n      onEdgeSelect(selected.id);\n      return;\n    }\n    if (selectedEdgeId !== null && changes.some((change) =>\n      change.type === "select" && !change.selected && change.id === selectedEdgeId\n    )) onEdgeSelect(null);\n  }, [onEdgeSelect, selectedEdgeId]);''',
)

replace_once(
    "src/project-edge-surface.mount.test.tsx",
    '''function edgeRecord(): ProjectEdgeRecord {\n  const now = "2026-08-13T11:30:00.000Z";\n  return {\n    id: "edge-a",\n    projectId: "project-a",\n    sourceItemId: "item-note",\n    targetItemId: "item-reference",\n    sourceHandle: "right",\n    targetHandle: "left",\n    markerStart: "none",\n    markerEnd: "arrow",\n    label: "feeds",\n    revision: 1,\n    createdBy: "user@example.com",\n    updatedBy: "user@example.com",\n    createdAt: now,\n    updatedAt: now,\n    deletedAt: null,\n    deletedBy: null,\n  };\n}''',
    '''function edgeRecord(overrides: Partial<ProjectEdgeRecord> = {}): ProjectEdgeRecord {\n  const now = "2026-08-13T11:30:00.000Z";\n  return {\n    id: "edge-a",\n    projectId: "project-a",\n    sourceItemId: "item-note",\n    targetItemId: "item-reference",\n    sourceHandle: "right",\n    targetHandle: "left",\n    markerStart: "none",\n    markerEnd: "arrow",\n    label: "feeds",\n    revision: 1,\n    createdBy: "user@example.com",\n    updatedBy: "user@example.com",\n    createdAt: now,\n    updatedAt: now,\n    deletedAt: null,\n    deletedBy: null,\n    ...overrides,\n  };\n}''',
)

path = Path("src/project-edge-surface.mount.test.tsx")
text = path.read_text()
start = text.index('  it("keeps keyboard node, edge, and empty selection synchronized", async () => {')
end = text.index('\n  it("renders four loose connection handles per node and an authoritative selectable Bezier edge"', start)
replacement = r'''  it("keeps keyboard node, multi-edge, and empty selection synchronized", async () => {
    const snapshot = projectTestSnapshot();
    const edgeA = edgeRecord();
    const edgeB = edgeRecord({
      id: "edge-b",
      sourceHandle: "bottom",
      targetHandle: "top",
      markerEnd: "none",
      label: "backs",
    });
    const stableNodes = projectMapNodes(snapshot);
    const stableEdges = [edgeA, edgeB];
    const onSelect = vi.fn();
    const onEdgeSelect = vi.fn();
    const onGeometryCommit = vi.fn();

    function KeyboardSelectionHarness() {
      const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
      const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
      const handleSelect = useCallback((itemId: string | null) => {
        onSelect(itemId);
        setSelectedItemId(itemId);
        if (itemId !== null) setSelectedEdgeId(null);
      }, []);
      const handleEdgeSelect = useCallback((edgeId: string | null) => {
        onEdgeSelect(edgeId);
        setSelectedEdgeId(edgeId);
        if (edgeId !== null) setSelectedItemId(null);
      }, []);
      return <ProjectMapSurface
        nodes={stableNodes}
        edges={stableEdges}
        selectedItemId={selectedItemId}
        selectedEdgeId={selectedEdgeId}
        onSelect={handleSelect}
        onEdgeSelect={handleEdgeSelect}
        onGeometryCommit={onGeometryCommit}
      />;
    }

    const { container } = render(<div style={{ width: 900, height: 700 }}><KeyboardSelectionHarness /></div>);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const liveNoteNode = () => container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    const liveEdge = (edgeId: string) => container.querySelector<SVGGElement>(`.react-flow__edge[data-id="${edgeId}"]`)!;
    await waitFor(() => {
      expect(liveEdge("edge-a")).toBeTruthy();
      expect(liveEdge("edge-b")).toBeTruthy();
    });

    fireEvent.focus(liveNoteNode());
    fireEvent.keyDown(liveNoteNode(), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("item-note"));

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.keyDown(liveNoteNode(), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(onEdgeSelect).not.toHaveBeenCalledWith("edge-a");
    expect(onEdgeSelect).not.toHaveBeenCalledWith("edge-b");

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.focus(liveEdge("edge-b"));
    fireEvent.keyDown(liveEdge("edge-b"), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-b"));
    await waitFor(() => expect(liveEdge("edge-b").classList.contains("selected")).toBe(true));

    onEdgeSelect.mockClear();
    fireEvent.focus(liveEdge("edge-a"));
    fireEvent.keyDown(liveEdge("edge-a"), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));
    await waitFor(() => {
      expect(liveEdge("edge-a").classList.contains("selected")).toBe(true);
      expect(liveEdge("edge-b").classList.contains("selected")).toBe(false);
    });
    expect(onEdgeSelect).not.toHaveBeenLastCalledWith(null);

    onEdgeSelect.mockClear();
    fireEvent.focus(liveEdge("edge-b"));
    fireEvent.keyDown(liveEdge("edge-b"), { key: " ", code: "Space" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-b"));
    await waitFor(() => {
      expect(liveEdge("edge-b").classList.contains("selected")).toBe(true);
      expect(liveEdge("edge-a").classList.contains("selected")).toBe(false);
    });
    expect(onEdgeSelect).not.toHaveBeenLastCalledWith(null);

    onEdgeSelect.mockClear();
    fireEvent.keyDown(liveEdge("edge-b"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith(null));
    await waitFor(() => expect(liveEdge("edge-b").classList.contains("selected")).toBe(false));
  });
'''
path.write_text(text[:start] + replacement + text[end:])
