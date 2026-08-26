# Responsive layout

This document is the source of truth for viewport-driven layout changes. It
keeps responsive behavior predictable while allowing content-driven components
to size themselves naturally.

## Viewport tiers

The application has three global viewport tiers and two baseline breakpoints:

| Tier | Viewport | Intended use |
| --- | --- | --- |
| Narrow | `<= 720px` | Phones and phone-specific interactions |
| Medium | `721px–1200px` | Tablets and compact laptops |
| Wide | `> 1200px` | Laptops and desktop displays |

Base styles describe the wide layout. General responsive overrides normally use
`@media (max-width: 1200px)` and `@media (max-width: 720px)`.

A component may retain an existing, explicitly documented local threshold when
that threshold owns a real interaction-mode or component-geometry boundary rather
than defining another application-wide viewport tier. The Project workspace is
the current scoped exception: `ProjectPage` uses `min-width: 860px` to decide
whether the editable desktop Map is available, while `project.css` uses the
existing `1180px`, `860px`, and `560px` thresholds for Project workspace,
directory, sidebar/Inspector, and save-banner layout. These values do not replace
the global `1200px` / `720px` tiers. They must be preserved and tested until a
separately measured Project-responsive change explicitly revises them.

Content-driven behavior is not a viewport tier. In particular:

- the Process grid may change column sizing according to the number of visible
  samples;
- inline Process grid comment composers keep short text and their tools on one
  row, then move the complete tool group below a full-width textarea when the
  text begins to wrap at the composer's actual width; images and attachments
  also lock this expanded state until the draft is cleared and focus leaves;
- horizontally scrollable Process grids remain scrollable whenever their
  content is wider than the viewport;
- wide Notes & observations takes its height from the left priority column and
  scrolls its note list internally; medium and narrow use the page scroll,
  showing the three most recent notes by default with an option to show all;
- text may wrap inside content regions, but button labels do not wrap inside a
  button.

## Global behavior

| Element | Wide | Medium | Narrow |
| --- | --- | --- | --- |
| Standard page gutter | 20px minimum | 20px | 14px |
| Primary navigation | Icon + label | Icon + label; hide long brand name | Icon only |
| Buttons | Label remains on one line | Label remains on one line unless explicitly icon-only | Use the documented mobile icon behavior |
| Dialogs | Existing desktop layout | Existing desktop layout where it fits | Existing narrow stacking |

The Process workspace keeps its established `90vw` wide layout. In medium it
has a `692px` width floor so the workspace does not become narrower when the
viewport crosses from `720px` to `721px`; it then returns naturally to `90vw`.
The narrow layout retains its existing 14px page gutter.

The global `720px` boundary has functional meaning. JavaScript viewport checks
for global narrow-mode behavior must use the same boundary and are only allowed
when interaction changes, not merely for styling. The Project workspace's
separate `860px` JavaScript check is also functional: it gates the editable Map
rather than adding a cosmetic CSS tier.

Page-load autofocus is input-capability driven rather than width-driven.
Standalone pages may autofocus a primary field only when the primary pointer is
fine and supports hover. Touch-style primary input waits for an explicit tap, so
navigation never opens the on-screen keyboard. Input dialogs opened by a user
action may continue to autofocus their first useful field.

## Project workspace

Project currently has one functional interaction boundary and two additional
local layout thresholds:

| Boundary | Current behavior |
| --- | --- |
| `>= 860px` | Desktop Project workspace is available, including the editable Map and the Map/Reading mode control. Between `860px` and `1180px`, the sidebar and Inspector use their existing compact desktop columns. |
| `<= 859px` | Desktop Map loading and editing are disabled; Project uses the Reading-first projection and the narrow Project directory/header/save-banner layout. |
| `<= 560px` | Project directory rows and create-form actions use the existing single-column phone arrangement. |

During any projection-locking save, edit, pending insertion/removal, paste,
delete, or edge operation, crossing the `860px` boundary does not immediately
replace the current projection. The current projection remains stable until the
operation is resolved, after which the current viewport rule is re-applied.

The `1180px` Project threshold is a local workspace-column adjustment, not the
global Wide/Medium boundary. The `860px` threshold must remain synchronized
between `ProjectPage` and `project.css` because it changes available interaction,
not only presentation. Phase 5A must validate the current values before changing
Project shell styling. Any proposal to alter one of them requires explicit
before/after measurements, interaction-mode verification, and adjacent-boundary
tests rather than being folded into a general visual cleanup.

## Samples directory

| Tier | Directory row | Filters |
| --- | --- | --- |
| Wide | Four columns: sample, state, process, updated | Four columns |
| Medium | First row: sample, state, updated. Second row: process | Two columns |
| Narrow | Existing compact sample/date row with process below | One column |

No directory row may require the desktop minimum width in the medium tier.

## Processing directory

| Tier | Controls | Directory row |
| --- | --- | --- |
| Wide | Filters and search side by side | Thumbnail, sample, process, status/date |
| Medium | Filters above full-width search; four filters stay on one row | Thumbnail and sample/status first, process on a second row |
| Narrow | Existing `2 x 2` filter grid above search | Existing phone layout |

## Process workspace

| Tier | Run controls | Process grid | Process plan interaction |
| --- | --- | --- | --- |
| Wide | Title, picker, status, and actions on one row | Existing content-driven desktop widths | Full labels and inline comments |
| Medium | Title, picker, status, and icon-only action-menu triggers on one row | Approximately 230px Process plan track and 300px minimum sample tracks | Full labels and inline comments |
| Narrow | Existing picker plus icon menu triggers | 88px Process plan track and 270px sample tracks | Icon actions and comment pop-out |

The following behavior is narrow-only and must not be moved to the medium tier:

- the 88px Process plan column;
- icon-only Process plan Done/Comment actions;
- hidden inline Process plan comments;
- the Process plan comment pop-out;

Run-menu triggers become icon-only in both medium and narrow tiers so the
complete control group remains on one row. Their menu items retain full labels
and descriptions.

The adaptive inline comment layout is independent of these viewport tiers. It
uses the rendered composer width because sample count can narrow a Process grid
column even on a wide screen. It applies to the inline Process plan and
individual sample-step composers only. The narrow Process plan comment dialog,
Sample Notes, and comment composers outside the Process grid retain their
existing layout.

## Sample detail

| Tier | Header actions | Priority area | Run history |
| --- | --- | --- | --- |
| Wide | All actions show labels | Details + Current structure beside Notes & observations | Runs and recent timeline side by side |
| Medium | Process and Metrology keep labels; Split and Export are icon-only | One column | Runs and recent timeline stacked; run summaries use two rows |
| Narrow | All header actions are icon-only | Existing phone order and spacing | Existing compact run summary |

In the wide layout, Notes & observations and the left priority column retain a
shared bottom edge. The left priority column alone sets their shared height;
additional Notes content scrolls inside the remaining list area and must not
increase the overview height. The two cards in the left column size to their own
content, and their gap remains fixed rather than absorbing height from Notes.

In medium and narrow layouts, Notes & observations must not create a nested
scroll region. The three most recent notes are shown in full by default. When
more notes exist, a touch-sized `Show all N notes` control reveals the complete
list in the normal page flow. Expanding replaces that control with the older
notes without moving content above the expansion point, and `Show recent 3`
appears only at the bottom of the complete list. Adding a note restores the
three-note view so the newest entry remains immediately visible.

## Templates

| Tier | Template lists | Template detail |
| --- | --- | --- |
| Wide | Existing single-row version facts | Title and actions share the heading row |
| Medium | Identity first, facts on explicit rows | Title above the action group |
| Narrow | Same information structure with narrow spacing | Existing phone layout |

Template Edit/Delete/Archive labels remain visible in every tier. Edit/View and
Delete share one baseline-aligned action group so title height cannot shift one
action independently. Process-step Edit/Delete actions also remain in one
non-wrapping group, while long step titles wrap in the remaining space. Template
picker dialogs remain two-column in medium and become one-column only in narrow.

## Boundary checks

Global responsive changes must be checked at both baseline boundary pairs:

- `720px` and `721px`;
- `1200px` and `1201px`.

A change to a component with documented local thresholds must also check each
adjacent pair owned by that component. Project shell or directory work therefore
checks:

- `559px`, `560px`, and `561px`;
- `859px` and `860px`;
- `1180px` and `1181px`.

At each applicable width:

- the page must not become narrower when crossing into a wider tier or local
  layout mode;
- content rows must not create unintended page-level horizontal overflow;
- button text must not wrap inside buttons;
- no isolated final button may fall onto a new row by accident;
- narrow-only icon and comment behavior must change only at `720px`;
- once any active projection lock is resolved, Project Map availability must
  follow the synchronized `860px` interaction boundary;
- wide Sample priority cards must not stretch internally when Notes grows;
- medium and narrow Notes must show three entries by default without nested
  scrolling, while wide Notes continues to show every entry inside its fixed
  scroll region.
