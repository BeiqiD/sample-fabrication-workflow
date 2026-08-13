from pathlib import Path

surface = Path("src/components/project/ProjectMapSurface.tsx")
text = surface.read_text()
old = """      minZoom={0.1}\n      maxZoom={2.5}\n      deleteKeyCode={null}"""
new = """      minZoom={0.1}\n      maxZoom={2.5}\n      zoomOnDoubleClick={false}\n      deleteKeyCode={null}"""
if text.count(old) != 1:
    raise SystemExit(f"expected one React Flow zoom anchor, found {text.count(old)}")
surface.write_text(text.replace(old, new, 1))

test = Path("src/project-map-surface.mount.test.tsx")
text = test.read_text()
anchor = "\n});\n"
if not text.endswith(anchor):
    raise SystemExit("unexpected Project Map surface test footer")
case = r'''

  it("reserves empty-pane double click for Markdown creation instead of viewport zoom", async () => {
    const onMarkdownCreateRequest = vi.fn();
    const descriptors = projectMapNodes(projectTestSnapshot());
    const { container } = render(<div style={{ width: 800, height: 600 }}>
      <ProjectMapSurface
        nodes={descriptors}
        selectedItemId={null}
        onSelect={() => undefined}
        onGeometryCommit={() => undefined}
        onMarkdownCreateRequest={onMarkdownCreateRequest}
      />
    </div>);

    const pane = await waitFor(() => {
      const candidate = container.querySelector<HTMLElement>(".react-flow__pane");
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
    expect(viewport).toBeTruthy();
    const beforeTransform = viewport!.style.transform;

    fireEvent.doubleClick(pane, { clientX: 400, clientY: 300 });

    await waitFor(() => expect(onMarkdownCreateRequest).toHaveBeenCalledTimes(1));
    const point = onMarkdownCreateRequest.mock.calls[0][0];
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(viewport!.style.transform).toBe(beforeTransform);
  });
'''
test.write_text(text[:-len(anchor)] + case + anchor)
