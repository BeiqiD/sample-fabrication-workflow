# Project Map performance and v1 functional-shape plan

Status: Phase 4C complete in PR #151

Last reviewed: 2026-08-18 after completing the representative-scale Project Map contract

## Goal

Phase 4C closes the interaction-shaping v1 work without replacing the normalized Project model. The same Project item, placement, edge, Reference, and Reading records must remain usable at the representative 200–300 node / 300–500 edge target and at the larger 500-node / 800-edge envelope.

## Architecture boundary

1. React Flow remains a renderer and interaction surface; it does not become an authoritative Canvas document.
2. Contextual zoom changes only mounted presentation detail on target/envelope maps. Ordinary maps remain full-detail at every zoom. Neither path changes Project content, placement geometry, z-order, Reading order, revisions, export, or source identity.
3. Visible-element rendering is enabled only at representative scale because its bookkeeping has a cost on small maps.
4. Node selection remains parent-authoritative. Selection-only changes reuse untouched React Flow node objects instead of rebuilding the complete projection.
5. Rich image previews, excerpts, and edge labels mount only at useful zoom. Connection handles remain mounted so React Flow retains correct edge geometry, but are visually hidden and non-connectable outside full detail unless the occurrence is primary-selected.
6. Detail bands use hysteresis. Small zoom fluctuations do not repeatedly mount and unmount rich content.
7. No schema migration, backend endpoint, bulk geometry write, background worker, or alternate cache is introduced.

## Delivered performance behavior

- `full` detail at ordinary working zoom renders the existing node content, previews, labels, handles, and actions;
- `compact` detail keeps identity and context while omitting excerpts, images, and ordinary edge labels;
- `overview` detail keeps type and title, visually suppresses ordinary connection handles while preserving their geometry anchors, and removes expensive card decoration;
- direct zoom jumps are handled, while separate enter/exit thresholds prevent threshold flicker;
- 200 nodes or 300 edges activate the representative-scale policy;
- 500 nodes or 800 edges activate the larger-envelope policy;
- target/envelope maps opt into React Flow visible-element rendering and contextual detail bands; ordinary maps retain the lower-overhead all-element path and established full-detail interaction at every zoom;
- Project node rendering is memoized, and controlled selection updates preserve object identity for untouched nodes;
- data attributes expose the active scale, culling policy, detail band, and counts for deterministic mounted verification and diagnostics.

## Executable scale contract

The permanent `pre-pr/project-map-performance` gate covers:

- scale thresholds and invalid-count normalization;
- contextual-zoom hysteresis and direct zoom jumps;
- real React Flow zoom controls moving representative-scale maps between overview and full detail while ordinary maps remain full-detail;
- a mounted 250-node / 400-edge representative target;
- a mounted 500-node / 800-edge larger envelope;
- no eager rich image previews at envelope startup;
- production TypeScript/Vite build and the existing Map bundle boundary.

This is a deterministic structural and interaction stress contract, not a claim that CI wall-clock timing predicts every browser or device. Phase 6B still owns supported-browser and realistic-data performance rehearsal.

## Final v1 include/defer decisions

### Included

- existing image previews at full detail;
- low-zoom summaries and selected-item action access;
- stable insertion-sequence Reading order;
- multi-selection, copy/paste, alignment assistance, explicit z-order, and bounded keyboard operations already completed in Phase 4B.

### Deferred

- groups/frames: current multi-selection and alignment operations are sufficient until real Project use proves a durable containment model is needed;
- richer PDF, webpage, video, audio, or scientific-format previewers: files remain safe cards/open actions for v1;
- custom Reading order: immutable `created_sequence` remains predictable and requires no second ordering model;
- JSON Canvas import/export, semantic search, and automatic layout: no concrete v1 requirement justifies reopening identity or interaction contracts.

These are explicit product decisions, not placeholders. Reintroducing one after feature freeze requires a concrete use case and a separate architecture review.

## Exit

The same Project occurrences support the intended spatial, inspection, navigation, and linear-reading workflow at representative scale. After PR #151 is accepted, the v1 interaction-shaping feature set can freeze and Phase 5 can refine the product without anticipating another primary-page restructure.
