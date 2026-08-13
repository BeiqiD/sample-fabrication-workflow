from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    if old in text:
        if text.count(old) != 1:
            raise SystemExit(f"expected one anchor in {path}, found {text.count(old)}")
        target.write_text(text.replace(old, new, 1))
        return
    if new in text:
        return
    raise SystemExit(f"anchor not found in {path}")


replace_once(
    "src/components/project/ProjectMapSurface.tsx",
    '''  const handleNodeClick = useCallback<NodeMouseHandler<ProjectFlowNode>>((_event, node) => {\n    if (!node.data.pendingReference && !node.data.pendingAttachment) {\n      onSelect(node.id);\n      onEdgeSelect(null);\n    }\n    setContextMenu(null);\n  }, [onEdgeSelect, onSelect]);\n  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: ProjectFlowEdge) => {\n    if (pendingEdge?.edgeId === edge.id) return;\n    onEdgeSelect(edge.id);\n    onSelect(null);\n    setContextMenu(null);\n  }, [onEdgeSelect, onSelect, pendingEdge]);''',
    '''  const handleNodeClick = useCallback<NodeMouseHandler<ProjectFlowNode>>((_event, node) => {\n    if (!node.data.pendingReference && !node.data.pendingAttachment) onSelect(node.id);\n    setContextMenu(null);\n  }, [onSelect]);\n  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: ProjectFlowEdge) => {\n    if (pendingEdge?.edgeId === edge.id) return;\n    onEdgeSelect(edge.id);\n    setContextMenu(null);\n  }, [onEdgeSelect, pendingEdge]);''',
)

replace_once(
    "src/components/project/ProjectMapSurface.tsx",
    '''  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode>>(({ nodes }) => {\n    const selected = [...nodes].reverse().find((node) => !node.data.pendingReference && !node.data.pendingAttachment);\n    if (selected) {\n      onSelect(selected.id);\n      onEdgeSelect(null);\n    }\n  }, [onEdgeSelect, onSelect]);''',
    '''  const handleSelectionChange = useCallback<OnSelectionChangeFunc<ProjectFlowNode>>(({ nodes }) => {\n    const selected = [...nodes].reverse().find((node) => !node.data.pendingReference && !node.data.pendingAttachment);\n    if (selected) onSelect(selected.id);\n  }, [onSelect]);''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const selectProjectEdge = useCallback((edgeId: string | null) => {\n    if (markdownEditorRef.current || attachmentEditorRef.current) return;\n    setSelectedItemId(null);\n    edgeController.selectEdge(edgeId);\n  }, [edgeController.selectEdge]);''',
    '''  const selectProjectEdge = useCallback((edgeId: string | null) => {\n    if (markdownEditorRef.current || attachmentEditorRef.current) return;\n    if (edgeId !== null) setSelectedItemId(null);\n    edgeController.selectEdge(edgeId);\n  }, [edgeController.selectEdge]);''',
)

replace_once(
    "src/lib/use-project-edge-controller.ts",
    '''  useEffect(() => () => {\n    activeRef.current = false;\n    transitionRef.current = null;\n  }, []);''',
    '''  useEffect(() => {\n    activeRef.current = true;\n    return () => {\n      activeRef.current = false;\n      transitionRef.current = null;\n    };\n  }, []);''',
)

replace_once(
    "src/project-edge-surface.mount.test.tsx",
    '''    const edge = edgeRecord();\n    const onEdgeSelect = vi.fn();\n    const { container } = render(<div style={{ width: 900, height: 700 }}>\n      <ProjectMapSurface\n        nodes={projectMapNodes(snapshot)}\n        edges={[edge]}\n        selectedItemId={null}\n        selectedEdgeId={null}\n        onSelect={() => undefined}\n        onEdgeSelect={onEdgeSelect}''',
    '''    const edge = edgeRecord();\n    const onSelect = vi.fn();\n    const onEdgeSelect = vi.fn();\n    const { container } = render(<div style={{ width: 900, height: 700 }}>\n      <ProjectMapSurface\n        nodes={projectMapNodes(snapshot)}\n        edges={[edge]}\n        selectedItemId={null}\n        selectedEdgeId={null}\n        onSelect={onSelect}\n        onEdgeSelect={onEdgeSelect}''',
)

replace_once(
    "src/project-edge-surface.mount.test.tsx",
    '''    for (const nodeId of ["item-note", "item-reference"]) {\n      const node = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`)!;\n      for (const handle of ["top", "right", "bottom", "left"]) {\n        expect(node.querySelector(`[data-handleid="${handle}"]`)).toBeTruthy();\n      }\n    }\n\n    const renderedEdge = await waitFor(() => {''',
    '''    for (const nodeId of ["item-note", "item-reference"]) {\n      const node = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`)!;\n      for (const handle of ["top", "right", "bottom", "left"]) {\n        expect(node.querySelector(`[data-handleid="${handle}"]`)).toBeTruthy();\n      }\n    }\n\n    const noteNode = container.querySelector<HTMLElement>('.react-flow__node[data-id="item-note"]')!;\n    fireEvent.click(noteNode);\n    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("item-note"));\n    expect(onEdgeSelect).not.toHaveBeenCalled();\n\n    const renderedEdge = await waitFor(() => {''',
)

replace_once(
    "src/project-edge-surface.mount.test.tsx",
    '''    fireEvent.click(renderedEdge);\n    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));''',
    '''    fireEvent.click(renderedEdge);\n    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledWith("edge-a"));\n    expect(onSelect).not.toHaveBeenCalledWith(null);''',
)

replace_once(
    "src/project-edges.mount.test.tsx",
    'import { forwardRef, useImperativeHandle } from "react";',
    'import { forwardRef, StrictMode, useImperativeHandle } from "react";',
)

replace_once(
    "src/project-edges.mount.test.tsx",
    '''function renderProjectPage() {\n  const router = createMemoryRouter([{\n    path: "/projects/:projectId",\n    element: <ProjectPage />,\n  }, {\n    path: "/projects",\n    element: <p>Projects route</p>,\n  }], { initialEntries: ["/projects/project-a"] });\n  return render(<RouterProvider router={router} />);\n}''',
    '''function renderProjectPage({ strict = false }: { strict?: boolean } = {}) {\n  const router = createMemoryRouter([{\n    path: "/projects/:projectId",\n    element: <ProjectPage />,\n  }, {\n    path: "/projects",\n    element: <p>Projects route</p>,\n  }], { initialEntries: ["/projects/project-a"] });\n  const view = <RouterProvider router={router} />;\n  return render(strict ? <StrictMode>{view}</StrictMode> : view);\n}''',
)

replace_once(
    "src/project-edges.mount.test.tsx",
    '''  it("exact-retries an uncertain edge create with the original endpoint revisions and operation identity", async () => {''',
    '''  it("keeps edge mutations active after the React StrictMode setup-cleanup-setup cycle", async () => {\n    let createCalls = 0;\n    fetchMock.mockImplementation((path, init) => {\n      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(projectTestSnapshot());\n      if (String(path) === "/api/projects/project-a/edges" && init?.method === "POST") {\n        createCalls += 1;\n        const input = JSON.parse(String(init.body)) as CreateProjectEdgeInput;\n        return jsonResponse({\n          value: edgeRecord({\n            id: input.edgeId,\n            sourceItemId: input.sourceItemId,\n            targetItemId: input.targetItemId,\n            sourceHandle: input.sourceHandle,\n            targetHandle: input.targetHandle,\n            markerStart: input.markerStart,\n            markerEnd: input.markerEnd,\n            label: input.label,\n          }),\n          replayed: false,\n        }, 201);\n      }\n      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);\n    });\n\n    renderProjectPage({ strict: true });\n    await waitForMap();\n    fireEvent.click(screen.getByRole("button", { name: "Connect edge fixture" }));\n\n    await waitFor(() => expect(screen.getByText("Edge count: 1")).toBeTruthy());\n    expect(createCalls).toBe(1);\n  });\n\n  it("exact-retries an uncertain edge create with the original endpoint revisions and operation identity", async () => {''',
)
