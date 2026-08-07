# Frontend interface guidelines

This document defines the layout, typography, density, interaction, and responsive rules for Sample Fabrication Workflow.

It complements [`COLOR_SYSTEM.md`](./COLOR_SYSTEM.md). The color document remains the source of truth for grayscale hierarchy, interaction accent behavior, workflow semantic colors, and action-result color mapping. This document focuses on geometry and information hierarchy.

## Purpose

The interface has already developed a recognizable visual language. The goal of this guideline is to make that language explicit without flattening useful differences between a normal reading page, a compact picker, and the high-density Process grid.

The desired outcome is **consistency by role, not uniformity by selector**.

A frontend cleanup must not automatically make every label, gap, card, image, or button the same size. Larger spacing is intentionally preserved where it improves reading. Dense controls remain dense where information throughput matters.

## Core principles

### 1. Preserve proven geometry before normalizing typography

Button groups, header actions, Process-grid controls, picker widths, image areas, and mobile action layouts are often coupled to available width and content wrapping. A typography cleanup must not silently resize or reflow these structures.

Before changing an established control or layout:

1. record its current width/height and surrounding geometry;
2. identify whether that geometry is a product constraint or an accidental implementation detail;
3. change typography or spacing independently where possible;
4. compare the same content cases before and after the change.

Existing button geometry is treated as protected unless the task explicitly targets button interaction or layout.

### 2. Use three density profiles

The application uses three intentional density profiles.

| Density | Typical use | Typography | Controls | Spacing |
| --- | --- | --- | --- | --- |
| **Comfortable** | Sample details, new/edit forms, template details, Settings/Export, major dialogs | body/value around 14 px; labels around 12 px | standard actions around 40–42 px | generous reading rhythm; card padding typically 18–24 px |
| **Compact** | Filters, pickers, directory rows, secondary toolbars, pagination, metadata panels | mostly 11–13 px | typically 34–40 px | gaps commonly 6–12 px |
| **Dense** | Process grid, inline execution comments, upload queues, cell actions | mostly 9–12 px | typically 28–32 px | gaps commonly 4–9 px |

These are profiles, not exact component APIs. Do not normalize a Dense control to Comfortable dimensions merely to reduce the number of CSS values.

### 3. Reading rhythm has priority over numerical uniformity

Normal pages should remain easy to read. The current interface benefits from visible separation between fields, cards, and sections.

Recommended rhythm by density:

| Relationship | Comfortable | Compact | Dense |
| --- | --- | --- | --- |
| Label → value/control | 6–8 px | 4–7 px | 2–5 px |
| Field → field | 12–18 px | 8–12 px | 4–9 px |
| Card internal grouping | 14–24 px | 10–16 px | 6–12 px |
| Major section separation | 26–42 px | 18–30 px | context-specific |

Do not reduce line-height or vertical spacing only to make cards shorter. A shorter card is not automatically a better card.

## Typography roles

The existing root tokens establish a useful hierarchy and should remain the default basis:

| Role | Current reference | Rule |
| --- | --- | --- |
| Page title | 34–52 px desktop; 38 px mobile | Reserved for route/page identity |
| Page lead | 17 px desktop; 15 px mobile | Short explanatory context below the page title |
| Section title | 22 px | Major section inside a page |
| Card title | 18 px | Card or local-content heading |
| Body / editable value | 14 px | Default readable value, note, and form-control text |
| Field label | 12 px | Normal data field name; sentence case |
| Metadata | 12 px | Timestamps, secondary context, supporting text |
| Micro metadata | 9–11 px | Dense grid, badges, upload state, compact technical metadata only |

### Field labels versus classification labels

Two different roles must not be conflated.

**Field labels** name editable or inspectable data, for example `Sample name`, `Location`, `Parameters`, or `Comments`.

- use sentence case;
- do not add letter spacing for decoration;
- default to approximately 12 px in Comfortable contexts;
- keep the same label treatment in view and edit states.

**Classification labels** identify hierarchy or category, for example page eyebrows, card kickers, table column headers, compact badges, Process-grid micro headings, or section indices.

- uppercase is allowed;
- letter spacing is allowed;
- 9–12 px is appropriate depending on density.

Uppercase must not be applied to a normal data field merely because it is rendered through a `dt` element.

### Control text must be explicit

The global CSS currently allows `input`, `textarea`, and `select` to inherit fonts from their parent. New or refactored form components should explicitly establish their intended control text size at the component/density level instead of accidentally inheriting a label size.

A field label and the text inside its control are different roles.

## View/edit parity

View and edit states for the same information are one component state, not two independent layouts.

The preferred pattern is:

1. keep fields in the same order;
2. keep labels in the same position and style;
3. replace only the editable value with its input/select/textarea;
4. keep non-editable context visible unless hiding it is necessary for the editing task;
5. put Save/Cancel actions in a predictable local action area;
6. avoid changing unrelated card geometry when editing starts.

### Height behavior

The natural read-only layout is the source of truth. Do not add a fixed minimum height to the view state only to make an edit transition look stable.

If the edit controls can fit within the natural view geometry, they should adapt to that geometry. A flexible text area may absorb remaining space. If the edit form genuinely requires more room, allow an intentional expansion rather than introducing empty space in the default view.

Runtime measurement is acceptable as a compatibility technique when current markup differs substantially between view and edit states, but structural parity is the preferred long-term solution.

## Controls and buttons

### Protected control geometry

The current interface already has a useful control-size ladder:

| Role | Current effective range |
| --- | --- |
| Standard page action | about 42 px high |
| Shell/navigation control | about 36–40 px |
| Compact toolbar/filter/pagination control | about 34–40 px |
| Dense Process-grid action | about 28–32 px |
| Mobile header icon action | about 42 px square |

This ladder should be treated as intentional. Do not replace it with one universal button height.

### Button variants

Continue using the existing roles:

- emphasized neutral / `.button.primary` for the page's primary non-semantic action;
- standard `.button` for ordinary actions;
- `.text-button` for low-emphasis inline actions;
- danger treatment for destructive actions;
- workflow semantic treatment only where allowed by `COLOR_SYSTEM.md`.

The same action should keep the same variant across pages. A visual-normalization change must not alter button meaning or emphasis.

### Mobile iconization

When labels are hidden on mobile and an established icon button remains, preserve the existing accessible label/title. Do not reintroduce text merely to make desktop and mobile markup visually identical.

## Cards and surfaces

The base `.card` establishes border, radius, paper surface, and shadow. Padding is intentionally owned by the component because different cards have different reading densities.

Typical Comfortable card padding is currently 18–24 px. This is a useful range, not a requirement that every card use one exact value.

When two cards serve the same role, their padding and heading rhythm should converge. When their roles differ — for example a directory row versus a long-form detail card — their density may differ.

Avoid introducing a new surface color or border strength just to compensate for weak spacing or hierarchy.

## Forms

### Comfortable forms

For Sample, Template, Metrology, Settings, and similar forms:

- labels should use the Field-label role;
- controls should use Body/editable-value typography;
- label-to-control gap should normally be 6–8 px;
- field-to-field gap should normally be 12–18 px;
- textareas should be sized for the content role, not normalized to one row count;
- optional text should be subordinate to the field label, not a second competing label.

### Compact forms

Filters, popovers, and picker forms may use smaller control text and tighter spacing. They must remain visually distinct from Dense Process-grid editing.

### Field naming and ordering

The same domain object should use the same field names and preferred order wherever practical. Sample creation, Sample detail editing, and Split-piece editing should be treated as variants of the same Sample identity schema rather than unrelated forms.

## Dense Process workspace

The Process grid is a deliberate exception to Comfortable-page typography.

Current characteristics that should be preserved unless the Process-grid task explicitly targets them:

- cell action heights around 28–29 px;
- comment tool buttons around 32 px;
- state and badge text around 9–10 px;
- comment body around 12 px with micro metadata around 9 px;
- cell and recipe-column padding optimized for multi-sample scanning;
- narrow mobile recipe column and horizontal sample scrolling;
- semantic state surfaces that communicate workflow state at a glance.

Do not apply normal-page field-label or button dimensions globally to the Process grid.

## Images and attachments

Image layout must be based on available width and image count, not only on the first-image case.

General rules:

- use a gallery/grid when several images share the same semantic role;
- on narrow mobile content, move multi-image galleries below text rather than forcing a long right-side image rail;
- in Dense Process-grid cells, narrow side thumbnails are allowed when they support scanning and do not crush text;
- preserve aspect ratio intentionally for previews;
- opening the image may use a larger lightbox without changing the compact inline representation;
- file attachments and image previews are separate visual roles even when both originate from the same upload system.

## Responsive rules

The current primary breakpoints are `1200px` and `720px`. Treat these as the default responsive boundaries.

Add another breakpoint only when a measured layout failure cannot be solved with intrinsic layout (`minmax`, wrapping, grid auto-fit, flex wrapping, container width, or content reordering).

### Desktop → intermediate → mobile

Responsive changes should preserve semantic priority rather than force pixel identity.

For example:

- page header actions may wrap or become icon-only;
- directory tables may collapse column headings into row structure;
- multi-sample grids may become horizontally scrollable;
- image galleries may move below text;
- dialog padding may reduce;
- touch targets must remain usable even when labels disappear.

## Dialogs, drawers, and menus

Overlay width is task-dependent and should not be normalized to one modal size. Current widths already form sensible role-specific categories, from narrow destructive confirmations to wide process-transition dialogs.

Behavior should be more consistent than width:

- focus must enter the overlay intentionally;
- Escape/backdrop behavior must be predictable;
- destructive confirmation should use the shared confirmation pattern;
- focus should be restored when practical;
- mobile padding/max-height must prevent content from becoming inaccessible.

Future destructive flows should prefer the shared `ConfirmDeleteDialog` behavior over browser-native `window.confirm()`.

## CSS ownership

Current load order is:

1. `styles.css` — base tokens, shared components, and most page/component CSS;
2. `palette.css` — interface color-role overrides;
3. `comment-layout.css` — targeted comment-layout compatibility overrides;
4. `sample-page-layout.css` — targeted Sample-page compatibility overrides.

This layering is acceptable as an intermediate state, but new single-bug override files should not become the default architecture.

When a component is deliberately refactored, move its stable rules toward the component's owning stylesheet/section and remove obsolete compatibility overrides. Avoid selector wars where a later file exists only to cancel an earlier rule.

## Protected layout invariants

Unless a task explicitly targets these areas, frontend normalization should preserve:

- page-level and Sample-header button variants and target sizes;
- mobile icon-button grouping;
- Process-grid column-width logic and sample-count behavior;
- Jump-to-current size/placement/visibility behavior;
- run-control and action-menu geometry;
- current responsive breakpoint behavior;
- Notes & observations mobile image grid;
- image-lightbox interaction area;
- status-pill color mapping and visual intensity;
- card reading spacing where no concrete problem has been identified.

## Measurement protocol

Before changing a mature frontend component, record the current baseline.

### Viewport matrix

At minimum inspect:

- 1440 px desktop for ordinary pages;
- 1024 px intermediate layout;
- 390 px common mobile width;
- 360 px minimum supported mobile case;
- a wide desktop viewport (approximately 1600–1920 px) for multi-sample Processing.

### Content matrix

Use representative stress cases:

- short and long Sample names;
- empty and multi-line descriptions;
- no parent, one parent, and multiple children;
- 0, 1, 3, and many images;
- attachment-only and mixed image/attachment notes;
- 1, 2, 3, 4, and many visible Process samples;
- long template names and long step content;
- empty, normal, and error states;
- light and dark themes.

### Geometry to record

For a component under change, record only the dimensions that matter to its behavior:

- outer width/height;
- primary control height;
- action-group width/wrapping;
- card padding;
- label/value spacing;
- image area dimensions;
- text wrapping/line count;
- neighboring component position when state changes.

Do not chase pixel equality for dimensions that do not affect hierarchy or interaction.

## Review checklist

Before merging a frontend-normalization change:

1. Identify the density profile of every affected component.
2. Confirm the change does not globally resize protected buttons or controls.
3. Confirm field labels and classification labels are not conflated.
4. Confirm control text does not accidentally inherit a new label size.
5. For view/edit UI, compare field order, label position, card geometry, and unrelated context.
6. Compare at 1440, 1024, 390, and 360 px where relevant.
7. Test long text and multi-image cases, not only the shortest fixture.
8. Confirm the Process grid remains dense unless it is the explicit target.
9. Confirm existing semantic colors and action-result rules remain intact.
10. Check both light and dark themes.
11. Prefer measured local changes over global selector overrides.
12. Update the frontend audit when a major component family changes density or interaction structure.
