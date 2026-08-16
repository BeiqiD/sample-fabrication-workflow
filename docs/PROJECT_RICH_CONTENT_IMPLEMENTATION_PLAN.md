# Project rich content implementation plan

Status: Phase 3D.1 implemented in Draft PR #143; final review and exact-head verification are tracked on the PR

Last reviewed: 2026-08-16 after final rich-content boundary hardening and branch history normalization

## Goal

Phase 3D turns the existing Map/Reading Project workspace into a durable mixed-media research narrative without introducing a second content model or a monolithic page editor. Project-owned Markdown source, attachment metadata, reference occurrences, placement, and edges remain authoritative in their existing normalized records. Rich HTML, MathML, image preview state, editor tabs, and human-readable archives are derived client state only.

## Architectural invariants

1. `project_contents.markdown_source` remains the only authoritative Markdown body. Generated HTML and MathML are never persisted.
2. Reading and Map consume the same `ProjectNodeDescriptor` projection. Reading may render the full narrative, while Map remains a compact spatial summary whose dimensions do not clip or define Reading content.
3. Reference occurrences stay read-only and source-owned. Phase 3D does not copy referenced source records into Project content.
4. Attachment bytes continue through the existing canonical Project file route. Image preview, file-card presentation, and export do not expose physical storage locators.
5. Existing expected revisions, operation IDs, exact retry behavior, conflict states, navigation protection, and the one-editor-at-a-time rule remain the mutation boundary.
6. This phase adds no schema migration, remote migration, deployment operation, or production-data rewrite.

## Rendering boundary

`src/lib/project-markdown.ts` owns the canonical renderer contract:

- CommonMark/GFM structure is parsed with a dedicated `Marked` instance rather than global mutable configuration;
- inline `$…$` / `\\(…\\)` and display `$$…$$` / `\\[…\\]` TeX are converted to MathML by Temml;
- raw HTML is rendered literally rather than executed;
- links and images use an explicit protocol allow-list; protocol-relative, script, data, control-character, backslash-normalized, and malformed destinations are rejected after final URL parsing;
- external HTTP(S) links receive `noopener noreferrer`;
- parser or TeX failures fall back to readable escaped source instead of failing the Reading projection;
- untrusted TeX uses bounded macro expansion and explicit relative/absolute size caps.

`ProjectMarkdown` is the shared presentation component. The use of `dangerouslySetInnerHTML` is intentionally confined to this component and receives only renderer-generated output under the boundary above. No caller supplies arbitrary HTML.

## Projection density

Reading is the complete narrative projection:

- Markdown headings, lists, tables, task lists, code, links, images, and TeX render at readable width independent of Map geometry;
- image attachments receive bounded inline previews and a portalled full-screen dialog using the shared focus, Escape, scroll-lock, and focus-restoration modal contract;
- non-image or failed-preview attachments use a generic file card;
- captions and source URLs remain attachment metadata and do not become embedded Markdown copies.

Map remains compact in Phase 3D.1. It keeps summary text and its existing authoritative edit state machine; full rich rendering inside every zoomable node is deliberately avoided because it would couple document layout to canvas geometry and inflate the React Flow bundle. The complete Reading module is dynamically imported only when the Reading projection is entered, so the desktop Map path does not eagerly load Marked and Temml.

## Editor boundary

Only the active Reading Markdown block dynamically imports `ProjectMarkdownEditor`. Inactive blocks ship no editor instance and retain no local editor mode. The editor provides source and preview tabs, but saving still calls the existing Project-owned Markdown update path through `ProjectPage`.

The state meanings remain unchanged:

- `editing`: local draft, explicit save available;
- `saving`: mutation in flight, draft locked;
- `uncertain`: only exact operation retry is allowed;
- `conflict`: cancel/reopen is required to load the authoritative revision;
- `error`: local draft remains available until cancellation or a new edit attempt.

A future Phase 3D slice may reuse this component inside Map and add bounded conflict comparison or coarse checkpoints. Those features do not require a content schema change.

## Human-readable export

`buildProjectReadableArchive()` consumes the same insertion-ordered descriptors used by Reading and produces:

- `reading.md`, preserving authoritative Markdown source and referencing packaged attachments through relative paths;
- `attachments/…`, downloaded from the existing Project attachment route;
- `manifest.json`, recording occurrence order and relative attachment locations without physical storage locators;
- `WARNINGS.md` when one or more attachment downloads fail.

Attachment failure is non-fatal: the narrative and manifest remain exportable, while the missing byte is explicit. The client packages at most 50 MB of authoritative attachment bytes per archive; later attachments are skipped before fetch and recorded in `WARNINGS.md`. This export is complementary to the full administrative backup and is not an import/restore format.

## Verification boundary

Phase 3D.1 verification covers:

- GFM and TeX rendering;
- raw-HTML and URL-protocol safety;
- lazy active-editor loading and authoritative save behavior;
- complete Reading order and responsive projection safety inherited from Phase 3C;
- image preview/dialog and generic file-card fallback;
- relative attachment packaging, deterministic manifest order, and partial-export warnings;
- ordinary TypeScript/build and existing Project persistence, Map, owned-content, edge, and Reading gates.

## Explicitly deferred

The following remain outside Phase 3D.1:

- WYSIWYG or block-editor persistence;
- a separate Reading ordering or layout table;
- rich rendering in every Map node;
- PDF document embedding, video/audio players, or format-specific scientific viewers;
- automatic background save;
- checkpoint tables, revision history UI, or three-way merge;
- export re-import/restore;
- schema migration, remote migration, deployment, or production-data operations.
