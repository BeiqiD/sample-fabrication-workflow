from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    '''Phase 3A1/3A2 and Phase 3B1/3B2/3B3 are complete through PR #135. Draft PR\n#136 implements Phase 3B4. The remaining sequence is:\n\n1. **Phase 3B4 — Basic edges (Draft PR #136)**: four handles, Bezier rendering,\n   endpoint direction, optional label, fixed endpoints, authoritative lifecycle,\n   exact retry, and client-session undo/redo.\n2. **Phase 3C — Reading projection**: no creation, complete insertion-order\n   rendering, and editing of existing owned content.\n3. **Phase 3D — Editor and media hardening**: Markdown/TeX editor, attachment\n   previews, save/conflict UX, and accessible Reading presentation.\n4. **Phase 4 — Advanced Canvas**: Inspector depth, groups, copy/paste,\n   multi-select hardening, PDF preview, screenshot capture, advanced performance,\n   and optional order/layout tooling.''',
    '''Phase 3A1/3A2 and Phase 3B1/3B2/3B3 are complete through PR #135. Phase 3B4\nis implemented in PR #136 and awaits clean re-review and squash merge. After\nthat merge, the remaining sequence starts with Phase 3C:\n\n1. **Phase 3C — Reading projection**: no creation, complete insertion-order\n   rendering, and editing of existing owned content.\n2. **Phase 3D — Editor and media hardening**: Markdown/TeX editor, attachment\n   previews, save/conflict UX, and accessible Reading presentation.\n3. **Phase 4 — Advanced Canvas**: Inspector depth, groups, copy/paste,\n   multi-select hardening, PDF preview, screenshot capture, advanced performance,\n   and optional order/layout tooling.''',
)

replace_once(
    "src/project-edges-contract.test.ts",
    '''    expect(roadmap).toContain("After PR #136 is squash-merged, add the no-creation **Reading projection** as Phase 3C");\n    expect(canvas).toContain("**Geometry undo/redo**");''',
    '''    expect(roadmap).toContain("After PR #136 is squash-merged, add the no-creation **Reading projection** as Phase 3C");\n    for (const document of [plan, roadmap, canvas]) expect(document).not.toContain("Draft PR #136");\n    expect(canvas).toContain("the remaining sequence starts with Phase 3C");\n    expect(canvas).toContain("**Geometry undo/redo**");''',
)
