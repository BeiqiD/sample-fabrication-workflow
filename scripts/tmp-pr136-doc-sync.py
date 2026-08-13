from pathlib import Path


def replace_once(path: str, old: str, new: str):
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "docs/PRODUCT_ROADMAP.md",
    """Last reviewed: 2026-08-12 after the reference/search foundation through PR #129,
the reusable Project discovery surface implemented in PR #130, the Map-first
Project review, the Phase 3A1 schema/export foundation implemented in PR #131,
the Phase 3A2 authoritative persistence service completed in PR #132, the
Phase 3B1 desktop Map kernel squash-merged in PR #133, Phase 3B2 reference
placement squash-merged in PR #134, and Phase 3B3 Project-owned Markdown and
generic attachment creation is implemented in Draft PR #135 and awaits
independent exact-head review""",
    """Last reviewed: 2026-08-13 after the reference/search foundation through PR #130,
Phase 3A1/3A2 Project persistence in PRs #131/#132, the Map kernel in PR #133,
reference placement in PR #134, and Project-owned content in PR #135 were
completed; Phase 3B4 basic Project-local edges are implemented in Draft PR #136
and await final exact-head verification and independent review""",
)
replace_once(
    "docs/PRODUCT_ROADMAP.md",
    """The active implementation target is independent review and completion of Draft
PR #135, the Phase 3B3 Project-owned Markdown and generic attachment creation
slice. Phase 3B4 starts only after that PR is squash-merged.""",
    """Phase 3B3 Project-owned Markdown and generic attachment creation is complete in
squash-merged PR #135. The active implementation target is Draft PR #136,
Phase 3B4 basic Project-local edges; Phase 3C starts only after this edge slice
is independently reviewed, exact-head verified, and squash-merged.""",
)
replace_once(
    "docs/PRODUCT_ROADMAP.md",
    """**Status:** implemented in Draft PR #135; keep Draft until independent exact-head
review and verification pass.""",
    """**Status:** complete; squash-merged in PR #135.""",
)
replace_once(
    "docs/PRODUCT_ROADMAP.md",
    """### Phase 3B4 — basic Project-local edges

**Goal:** support Obsidian-Canvas-like relationship drawing without advanced""",
    """### Phase 3B4 — basic Project-local edges

**Status:** implemented in Draft PR #136; final exact-head verification and independent review pending.

**Goal:** support Obsidian-Canvas-like relationship drawing without advanced""",
)

replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    "Status: product and architecture contract during Phase 3B3 Draft review in PR #135",
    "Status: product and architecture contract during Phase 3B4 implementation and Draft review in PR #136",
)
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    """Last reviewed: 2026-08-12 after the Map-first Project interaction review,
Phase 3A1 implemented in PR #131, the authoritative persistence service merged
in PR #132, the Map kernel squash-merged in PR #133, Phase 3B2 reference
placement squash-merged in PR #134, and Phase 3B3 Project-owned content entered
Draft review in PR #135""",
    """Last reviewed: 2026-08-13 after Phase 3A persistence in PRs #131/#132, the Map
kernel in PR #133, reference placement in PR #134, and Project-owned content in
PR #135 were completed; Phase 3B4 basic Project-local edges are implemented in
Draft PR #136 and await final exact-head verification and independent review""",
)
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    """merged PR #134 delivers Phase 3B2 reference
discovery and authoritative placement; Draft PR #135 implements the bounded
Phase 3B3 Project-owned Markdown and generic attachment creation layer without
selecting a rich editor.""",
    """merged PR #134 delivers Phase 3B2 reference
discovery and authoritative placement; merged PR #135 delivers bounded Phase
3B3 Project-owned Markdown and generic attachment creation; Draft PR #136
implements Phase 3B4 basic Project-local edges without widening the normalized
graph model.""",
)
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    """The Phase 3B3 content-creation boundary is in
[PROJECT_OWNED_CONTENT_IMPLEMENTATION_PLAN.md](./PROJECT_OWNED_CONTENT_IMPLEMENTATION_PLAN.md).
The stable reference, lifecycle, search, and storage boundaries remain in their""",
    """The Phase 3B3 content-creation boundary is in
[PROJECT_OWNED_CONTENT_IMPLEMENTATION_PLAN.md](./PROJECT_OWNED_CONTENT_IMPLEMENTATION_PLAN.md).
The Phase 3B4 edge mutation, retry, history, and verification boundary is in
[PROJECT_EDGES_IMPLEMENTATION_PLAN.md](./PROJECT_EDGES_IMPLEMENTATION_PLAN.md).
The stable reference, lifecycle, search, and storage boundaries remain in their""",
)
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    """Phase 3A1 and Phase 3A2 are complete in PR #131 and PR #132. Phase 3B1 is
complete in merged PR #133. Phase 3B2 is the current Draft PR #134. The sequence
is:

1. **Phase 3B2 — Reference sidebar and placement (Draft PR #134)**: search,
   desktop drag/drop, pending/reconciliation states, keyboard center placement,
   authoritative insertion, exact retry, and Project-local removal.
2. **Phase 3B3 — Project-owned creation**: double-click Markdown, generic Add
   attachment, image/file rendering, and automatic insertion-order Reading
   inclusion; this starts only after #134 is complete and merged.
3. **Phase 3B4 — Basic edges**: four handles, Bezier, endpoint direction, label,
   delete/recreate behavior.
4. **Phase 3C — Reading projection**: no creation, complete insertion-order""",
    """Phase 3A1/3A2 and Phase 3B1/3B2/3B3 are complete through PR #135. Draft PR
#136 implements Phase 3B4. The remaining sequence is:

1. **Phase 3B4 — Basic edges (Draft PR #136)**: four handles, Bezier rendering,
   endpoint direction, optional label, fixed endpoints, authoritative lifecycle,
   exact retry, and client-session undo/redo.
2. **Phase 3C — Reading projection**: no creation, complete insertion-order""",
)
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    "5. **Phase 3D — Editor and media hardening**:",
    "3. **Phase 3D — Editor and media hardening**:",
)
replace_once(
    "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md",
    "6. **Phase 4 — Advanced Canvas**:",
    "4. **Phase 4 — Advanced Canvas**:",
)
