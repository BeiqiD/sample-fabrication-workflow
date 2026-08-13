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
    '''  type Connection,\n  type Edge,\n  type Node,''',
    '''  type Connection,\n  type Edge,\n  type EdgeChange,\n  type Node,''',
)

replace_once(
    "src/components/project/ProjectMapSurface.tsx",
    '''  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode>>(({ nodes }) => {\n    const selected = [...nodes].reverse().find((node) => !node.data.pendingReference && !node.data.pendingAttachment);\n    if (selected) onSelect(selected.id);\n  }, [onSelect]);''',
    '''  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode, ProjectFlowEdge>>(({ nodes, edges }) => {\n    const selectedNode = [...nodes].reverse().find((node) => !node.data.pendingReference && !node.data.pendingAttachment);\n    if (selectedNode) {\n      onSelect(selectedNode.id);\n      return;\n    }\n    const selectedEdge = [...edges].reverse().find((edge) => edge.id !== pendingEdge?.edgeId);\n    if (selectedEdge) {\n      onEdgeSelect(selectedEdge.id);\n      return;\n    }\n    onSelect(null);\n    onEdgeSelect(null);\n  }, [onEdgeSelect, onSelect, pendingEdge]);\n  const handleEdgesChange = useCallback((changes: EdgeChange<ProjectFlowEdge>[]) => {\n    const selection = [...changes].reverse().find((change) => change.type === \"select\");\n    if (!selection || selection.type !== \"select\") return;\n    if (selection.selected) {\n      onEdgeSelect(selection.id);\n      return;\n    }\n    if (selection.id === selectedEdgeId) onEdgeSelect(null);\n  }, [onEdgeSelect, selectedEdgeId]);''',
)

replace_once(
    "src/components/project/ProjectMapSurface.tsx",
    '''      onNodesChange={onNodesChange}\n      onNodeClick={handleNodeClick}''',
    '''      onNodesChange={onNodesChange}\n      onEdgesChange={handleEdgesChange}\n      onNodeClick={handleNodeClick}''',
)


test_path = Path("src/project-edge-surface.mount.test.tsx")
text = test_path.read_text()
anchor = '''  it("renders four loose connection handles per node and an authoritative selectable Bezier edge", async () => {'''
if text.count(anchor) != 1:
    raise SystemExit("surface test anchor not unique")
new_test = r'''  it("keeps keyboard node, edge, and empty selection synchronized", async () => {
    const snapshot = projectTestSnapshot();
    const edge = edgeRecord();
    const onSelect = vi.fn();
    const onEdgeSelect = vi.fn();
    const { container } = render(<div style={{ width: 900, height: 700 }}>
      <ProjectMapSurface
        nodes={projectMapNodes(snapshot)}
        edges={[edge]}
        selectedItemId={null}
        selectedEdgeId={null}
        onSelect={onSelect}
        onEdgeSelect={onEdgeSelect}
        onGeometryCommit={() => undefined}
      />
    </div>);

    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    const noteNode = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;
    const renderedEdge = await waitFor(() => {
      const candidate = container.querySelector<SVGGElement>('.react-flow__edge[data-id="edge-a"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });

    fireEvent.focus(noteNode);
    fireEvent.keyDown(noteNode, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("item-note"));

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.keyDown(noteNode, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(onEdgeSelect).toHaveBeenCalledWith(null);

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.focus(renderedEdge);
    fireEvent.keyDown(renderedEdge, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));
    expect(onSelect).not.toHaveBeenCalledWith(null);

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.keyDown(renderedEdge, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith(null));

    onSelect.mockClear();
    onEdgeSelect.mockClear();
    fireEvent.focus(renderedEdge);
    fireEvent.keyDown(renderedEdge, { key: " ", code: "Space" });
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));
  });

'''
text = text.replace(anchor, new_test + anchor, 1)
text = text.replace('''    expect(onEdgeSelect).not.toHaveBeenCalled();''', '''    expect(onEdgeSelect).not.toHaveBeenCalledWith("edge-a");''', 1)
test_path.write_text(text)
