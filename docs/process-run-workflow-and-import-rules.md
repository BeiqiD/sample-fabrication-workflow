# Process Run Workflow and FabuBlox Import Rules

## Purpose

The system tracks a physical sample across multiple, independently meaningful processing stages.

The three core entities are:

- **Sample**: the physical object, its current structure, and its complete processing history.
- **Process template**: a versioned processing plan that can be reused and updated.
- **Process run**: one concrete execution of a process template on one sample.

Metrology templates and records are independent of this fabrication lifecycle. A metrology record may appear between process steps or run on its own, but it does not change process completion, sample status, or current structure.

The Sample page answers:

> What has this sample experienced, and what is its current structure?

The Process Run page answers:

> What was the starting structure for this run, what happened during it, and what structure did it produce?

## Process run lifecycle

### Active run

An active run records the current processing stage. Its completed steps are historical facts and remain frozen. Future planned steps may still be updated from a newer version of the same process template.

Available actions:

- Continue processing.
- Update the future plan.
- Finish the run after all current steps are done or skipped.

### Completed run

Completing a run means that processing stage has ended. It does not mean that the physical sample can no longer undergo other processing.

A completed run is read-only by default. It retains:

- Its immutable initial substrate snapshot.
- The process template versions applied during its lifetime.
- All completed and skipped steps.
- Actual parameters, comments, diagrams, and attachments.
- Its final structure.
- Its completion event and timestamp.

### Reopen or continue a completed run

Updating a process template does not automatically change or reopen any run.

A completed run may be reopened only when:

- It is the sample's latest process run.
- No later process run has already been created.
- The user explicitly applies an updated version of the same process template to continue the same processing objective.

Reopening preserves the original completion event and appends a new event such as:

```text
Run started
→ Run completed
→ Run reopened with Process template v2
→ Run completed again
```

Previously executed steps remain frozen. Only the future plan is added or updated.

If a later process run already exists, the earlier run cannot be reopened because that would rewrite the established fabrication sequence. Independent metrology runs do not block reopening the latest process run.

### Start a new run

Starting a new run creates an independent processing stage on the same sample.

- Earlier runs remain completed.
- The new run receives its own immutable initial substrate snapshot.
- The system compares the sample's last recorded structure with Step 0 of the selected Process template.
- The user confirms that this structure handoff is expected. The confirmation is not a choice between two structures.
- The new run stores the selected Process template's Step 0 as its immutable initial substrate snapshot.
- Starting a new run does not reopen or modify an earlier run.

## Sample page organization

The Sample page is the primary overview of earlier and later processing.

It should show:

1. Sample identity and basic metadata.
2. The sample's current structure diagram.
3. The active process run, if one exists.
4. A chronological process run history.
5. A clear action to start a new run when allowed.

### Current process

If a run is active, show a prominent current-run card with:

- Run number.
- Process template name and version.
- Progress.
- Active status.
- A `Continue processing` action.

### Process history

Show all runs as compact cards or links, newest first.

Each card should show:

- Run number.
- Process template name and version.
- Active or completed status.
- Start and completion time, where applicable.
- A link to the full Process Run page.

Historical runs are collapsed by default. Clicking a run card expands a compact structural history:

```text
Initial substrate
→ process diagrams that changed the structure
→ final structure
```

Steps without diagrams do not need to occupy space in this structural preview. Full steps, parameters, comments, diagrams, and attachments remain on the Process Run page.

The final diagram of an old run must be labelled **Final structure**, not **Current structure**. Only the Sample-level diagram represents the sample's current state.

### Avoid mixed selectors

Do not combine these concepts in one area:

- Selecting an existing run to view.
- Selecting a process template for a new run.
- Starting a new run.

There should not be an inactive or single-option `Process run` dropdown beside a permanently visible `Start processing` template selector.

Instead:

- Run cards and links are used to view history.
- `Start new run` is a Sample-level action.
- Template selection and substrate confirmation occur inside the new-run dialog.

## Process Run page organization

The Process Run page represents exactly one run.

It should display:

- Immutable initial substrate snapshot.
- Current structure for an active run, or final structure for a completed run.
- Complete step execution history.
- Actual parameters, comments, diagrams, and attachments.
- Template updates applied to the run.
- Run lifecycle events.

Actions depend on state:

- **Active run**: `Update future plan` and the destructive `Finish run` action live under `Run actions`.
- **Latest completed run with no successor**: `Reopen with updated template`, when a compatible newer template version exists.
- **Completed run with a successor**: read-only.
- **Any selected process or metrology run**: `Delete run` permanently removes the run entity and its
  steps, comments, attachment associations, plan revisions, and verification entities after an
  explicit destructive confirmation.

Normal process completion remains automatic when the final current fabrication step is done or
skipped. Using `Finish run` before that point is an early-finish operation: it requires explicit
confirmation, atomically marks every unfinished current fabrication step as skipped, and records
the affected step IDs in the run history.

Run-level mutations are grouped under `Run actions`; creation of a new process or standalone
metrology record is grouped separately under `Start run`. These controls keep stable positions
while their menu contents follow the selected run.

Deleting a run is reserved for accidental creation and is distinct from cancellation. Existing
sample Timeline text remains as read-only audit history, while detached files use the same
orphaned-object retention and delayed cleanup path as normal comment deletion. A cancelled run,
by contrast, represents work that really started and stopped, so the run and its partial execution
record remain visible.

## Process template update semantics

The following are separate operations:

1. **Create a new Process template version**
   - Changes only the reusable plan.
   - Does not automatically affect any run.

2. **Update or reopen an existing run**
   - Applies a compatible template version to the same run.
   - Preserves execution status and user-entered evidence.
   - Refreshes the current plan from the newer template, including completed matched entries.

3. **Start a new run**
   - Creates a new processing stage.
   - Leaves all previous runs completed.

Across template versions, process-step identity is based on normalized step names and does not depend on step order. Step numbers are display information. Parameters, notes, and diagrams describe version changes and normally do not determine identity.

Repeated names such as `Clean`, `Bake`, or `Inspection` are disambiguated by unchanged definitions first, then stable logical keys, and finally occurrence order. This lets reordered steps retain their run status and user-entered evidence while still recognizing insertions between otherwise identical names.

New steps may be inserted on either side of the run's execution boundary. An inserted step before a later actualized match is recorded as `skipped` when the new version is assigned, because the sample has already passed that point. Additions after the boundary remain `pending`. Before any step has been actualized, all additions remain `pending`.

An imported template version remains editable until it is assigned to a run. Editable process steps can be added, changed, or deleted as a whole. Individual imported diagrams cannot be deleted independently; deleting the step removes its diagram references with it while retaining shared content-addressed asset data.

## FabuBlox initial substrate import

### Current problem

The import page currently shows a separate block such as:

```text
Initial substrate structure

No starting diagram
A new process run can use this structure, or explicitly continue from the sample's current structure.
```

This is based on an incorrect assumption that an initial substrate diagram must exist before the imported process steps.

In the FabuBlox template, the first item is already:

```text
Step 0 — Substrate Stack
```

Its content defines the process template's starting substrate structure and must be read directly.

### Required import rule

For every newly imported Process template version:

1. Locate Step 0 named `Substrate Stack`.
2. Parse its layer-stack content and diagram using the same attachment and image-import pipeline used for other process diagrams.
3. Save this content as the Process template version's immutable **initial substrate snapshot**.
4. Do not import `Substrate Stack` as a normal executable Process step.
5. Begin the executable run plan with Step 1.

The initial substrate snapshot should retain all meaningful Step 0 content, including:

- Diagram or schematic.
- Layer names and order.
- Materials.
- Thicknesses and other available structured parameters.
- Notes or text belonging to the substrate definition.
- Source attachment reference where applicable.

### Import preview

The preview should present Step 0 explicitly:

```text
Initial substrate · Step 0: Substrate Stack
[diagram]
[parsed layer-stack details]
```

Possible states should be precise:

- `Substrate Stack detected` with its diagram and parsed contents.
- `Substrate Stack detected, but no diagram was found`.
- `Step 0: Substrate Stack was not found`.

The importer should not display a generic `No starting diagram` merely because it did not find an image before the first row. It should not silently borrow the diagram from Step 1.

If Step 0 is missing or ambiguous, the user should be warned before confirming the import. The importer must not invent an initial substrate from another process step.

### Run creation

When a Process template version is used to create or update a run:

- The left side displays the sample's last recorded structure, normally the last completed step of its latest run.
- The right side displays the incoming Process template's Step 0 snapshot.
- The dialog asks whether this handoff matches the expected physical structure.
- There is no radio-button choice between the two sides.
- Starting a new run stores the incoming Step 0 snapshot as that run's immutable initial substrate.
- Updating or reopening a run records the confirmation without rewriting that run's original initial substrate.
- If the sample, latest run, run-plan revision, or either compared structure changes after preview, the confirmation becomes stale and must be repeated.

If the template option has no diagram, the dialog must explain the actual condition, for example:

```text
Step 0: Substrate Stack was imported without a diagram.
```

It should not show an empty card that appears to be a rendering failure.

## Acceptance criteria for the import correction

- A workbook whose Step 0 is `Substrate Stack` displays that step's diagram and details in the import preview.
- The imported Process template version stores the Step 0 content as its initial substrate snapshot.
- Step 0 does not appear as an executable run step.
- Step 1 is the first executable process step.
- Starting a run with the template-defined substrate displays the Step 0 schematic.
- Updating the template creates a new version-specific initial substrate snapshot without changing existing runs.
- The transition dialog never silently substitutes the sample's current structure for the template's Step 0.
- Missing or malformed Step 0 content produces a clear warning rather than a misleading generic empty state.
