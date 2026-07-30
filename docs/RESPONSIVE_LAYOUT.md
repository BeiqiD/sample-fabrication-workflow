# Responsive layout

This document is the source of truth for viewport-driven layout changes. It
keeps responsive behavior predictable while allowing content-driven components
to size themselves naturally.

## Viewport tiers

The application has three viewport tiers and only two CSS breakpoints:

| Tier | Viewport | Intended use |
| --- | --- | --- |
| Narrow | `<= 720px` | Phones and phone-specific interactions |
| Medium | `721px–1200px` | Tablets and compact laptops |
| Wide | `> 1200px` | Laptops and desktop displays |

Base styles describe the wide layout. Responsive overrides use only
`@media (max-width: 1200px)` and `@media (max-width: 720px)`.

Content-driven behavior is not a viewport tier. In particular:

- the Process grid may change column sizing according to the number of visible
  samples;
- horizontally scrollable Process grids remain scrollable whenever their
  content is wider than the viewport;
- Notes & observations grows with its content and uses its existing scroll
  limit;
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

The `720px` boundary has functional meaning. JavaScript viewport checks must use
the same boundary and are only allowed when interaction changes, not merely for
styling.

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
| Medium | Title/picker/status first, action group on a second row | Approximately 230px Process plan track and 300px minimum sample tracks | Full labels and inline comments |
| Narrow | Existing picker plus icon menu triggers | 88px Process plan track and 270px sample tracks | Icon actions and comment pop-out |

The following behavior is narrow-only and must not be moved to the medium tier:

- the 88px Process plan column;
- icon-only Process plan Done/Comment actions;
- hidden inline Process plan comments;
- the Process plan comment pop-out;
- icon-only run-menu triggers.

## Sample detail

| Tier | Header actions | Priority area | Run history |
| --- | --- | --- | --- |
| Wide | All actions show labels | Details + Current structure beside Notes & observations | Runs and recent timeline side by side |
| Medium | Process and Metrology keep labels; Split and Export are icon-only | One column | Runs and recent timeline stacked; run summaries use two rows |
| Narrow | All header actions are icon-only | Existing phone order and spacing | Existing compact run summary |

In the wide layout, Notes & observations and the left priority column retain a
shared bottom edge. The two cards in the left column size to their own content;
extra height belongs between those cards and must never stretch their contents.

## Templates

| Tier | Template lists | Template detail |
| --- | --- | --- |
| Wide | Existing single-row version facts | Title and actions share the heading row |
| Medium | Identity first, facts on explicit rows | Title above the action group |
| Narrow | Same information structure with narrow spacing | Existing phone layout |

Template Edit/Delete/Archive labels remain visible in every tier. Template
picker dialogs remain two-column in medium and become one-column only in
narrow.

## Boundary checks

Responsive changes must be checked at all four boundaries:

- `720px` and `721px`;
- `1200px` and `1201px`.

At each width:

- the page must not become narrower when crossing into a wider tier;
- content rows must not create unintended page-level horizontal overflow;
- button text must not wrap inside buttons;
- no isolated final button may fall onto a new row by accident;
- narrow-only icon and comment behavior must change only at `720px`;
- wide Sample priority cards must not stretch internally when Notes grows.
