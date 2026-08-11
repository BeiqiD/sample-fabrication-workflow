# Project Map kernel implementation plan

Status: Phase 3B1 implemented in current Draft PR #133; independent review pending

Last reviewed: 2026-08-11 after Phase 3A2 was squash-merged in PR #132

This plan defines the bounded frontend slice that turns the normalized Project
snapshot into the first spatial Project surface. It is subordinate to
[PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md) and
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).
The authoritative persistence boundary remains
[PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md](./PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md).

## Scope

Phase 3B1 implements only the Map kernel required to view and reposition existing
Project occurrences:

- replace the temporary standalone Search navigation destination with Projects;
- Project list, create, and open shell;
- load `@xyflow/react` dynamically only when a desktop Project Map is opened;
- derive lightweight Markdown, attachment, and reference cards from the
  normalized Project snapshot;
- pan, zoom, selection, fit view, move, and border resize;
- maintain placement drafts separately from the authoritative snapshot;
- explicit Save plus bounded 1.6-second autosave after semantic placement changes;
- client-session undo/redo for completed move and resize commands;
- lightweight read-only selection Inspector;
- deterministic mobile read-only occurrence projection ordered by
  `createdSequence` and item ID.

It deliberately does not add reference insertion, Markdown creation, attachment
upload/creation, edge authoring, a rich Markdown editor, or the complete Reading
projection.

## Renderer and persistence boundary

React Flow is a renderer and interaction model, never the persistence format.
The client derives nodes from `ProjectSnapshot` and writes only normalized
placement mutations.

Live pointer movement and resize frames update local geometry only. Persistence
is permitted at four semantic boundaries:

1. drag stop;
2. resize end, through the bounded autosave queue;
3. explicit Save;
4. the bounded autosave flush.

Each write sends the placement's current expected revision and a fresh operation
ID. A successful response replaces the local authoritative baseline and revision.
A `409` preserves the visible local draft, enters Conflict state, and requires
an authoritative snapshot reload rather than silent overwrite.

## Undo and redo

Session history records one before/after command per completed move or resize.
It is not permanent operation history. Undo and redo only change the local
placement draft; Save or autosave persists the resulting current geometry as an
ordinary new placement revision.

## Responsive boundary

Desktop (`min-width: 901px`) may initialize the dynamically imported Map editor.
Narrow/mobile layouts do not import or initialize React Flow. They render the
same active occurrences as a read-only deterministic list and explicitly avoid
claiming the later Phase 3C Reading editing contract.

## Dependency boundary

Phase 3B1 uses `@xyflow/react` 12.11.2 under the MIT license. The dependency is
owned by the lazy desktop Map module, not by the initial application route
bundle. No editor, PDF renderer, or other Project creation dependency is added in
this slice.

## Verification

The permanent `verify:project-map` gate must run on the exact PR head and cover:

- Project API list/create/open and placement request contracts;
- normalized snapshot-to-node projection;
- deterministic mobile ordering;
- desktop lazy ownership and removal of the temporary Search navigation route;
- no reference/content creation or edge-authoring authority in the Map kernel;
- semantic-boundary placement persistence with no per-frame network writes;
- explicit Save and bounded autosave;
- session undo/redo;
- `409` conflict preservation and authoritative reload;
- mobile non-initialization of React Flow.

The long-lived Verify workflow owns `pre-pr/project-map`; no temporary workflow
may synthesize that status or mutate the PR branch. The exact head must also pass
Project foundation/persistence, Reference, blob, full ordinary/mounted tests,
and production build gates.

## Exit

Phase 3B1 exits only when the implementation is visible in the ordinary GitHub
PR diff, the bootstrap/finalizer workflow is absent, the exact head has a real
`pre-pr/project-map` status from the permanent Verify workflow, and independent
review finds no runtime merge blocker.

After squash merge, Phase 3B2 becomes the immediate next PR and mounts the
existing reusable Reference search surface inside Project for authoritative
reference placement.
