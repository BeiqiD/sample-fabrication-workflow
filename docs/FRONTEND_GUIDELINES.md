# Frontend interface guidelines

Status: **frozen normative baseline**  
Established code baseline: **`main` at `f7eeb932c0b6771dc2d6471077447b2297bf9017`**  
Measured implementation reference: [`FRONTEND_AUDIT.md`](./FRONTEND_AUDIT.md)  
Color source of truth: [`COLOR_SYSTEM.md`](./COLOR_SYSTEM.md)

This document defines the layout, typography, density, interaction, responsive, and validation rules for Sample Fabrication Workflow.

The 2026-08 normalization pass is complete. These guidelines now describe the established interface rather than a plan for broad cleanup. Future changes should solve a concrete problem and preserve mature geometry outside the task's scope.

The governing principle is:

> **Consistency by role, not uniformity by selector.**

A reading page, a compact picker, and the high-density Process grid are intentionally different. A smaller number of CSS values is not a product goal. Readability, information priority, interaction safety, and stable geometry are the goals.

## 1. Change gate

Before modifying an established frontend component, the change must have a clear reason such as:

- a reproducible usability or accessibility problem;
- incorrect or unstable responsive behavior;
- inconsistent representation of the same domain field;
- a data-integrity or interaction-safety issue;
- duplicated behavior that is demonstrably difficult to maintain;
- a measured layout failure under representative content.

The following are not sufficient reasons on their own:

- another component uses a different padding value;
- two unrelated buttons have different heights;
- a Dense workspace does not look like a Comfortable form;
- a component-scoped stylesheet increases the stylesheet count;
- a desire to make every label uppercase, sentence case, or the same size globally.

Every frontend PR should state:

1. the concrete problem;
2. the affected density profile;
3. the relevant before/after measurements;
4. the protected geometry that remains unchanged;
5. the viewport/content/theme cases tested.

## 2. Core principles

### 2.1 Preserve proven geometry before normalizing typography

Button groups, header actions, Process-grid controls, picker widths, image areas, and mobile action layouts are often coupled to available width and content wrapping.

Before changing them:

1. record the current geometry;
2. distinguish product constraints from accidental implementation details;
3. make the smallest local change possible;
4. compare the same content cases before and after;
5. avoid changing unrelated controls through broad selectors.

Existing button and Process-workspace geometry is protected unless the task explicitly targets it.

### 2.2 Use three density profiles

| Density | Typical use | Typography | Controls | Spacing |
| --- | --- | --- | --- | --- |
| **Comfortable** | Sample details, ordinary forms, Template details, Settings/Export, major dialogs | labels ~12 px; body/value ~14 px | ~40–42 px | generous reading rhythm; cards typically 18–24 px padding |
| **Compact** | Filters, pickers, directory rows, secondary toolbars, pagination | mostly 11–13 px | ~34–40 px | commonly 6–12 px gaps |
| **Dense** | Process grid, execution comments, upload queues, cell actions | mostly 9–12 px | ~28–32 px | commonly 4–9 px gaps |

These are intentional profiles. Do not enlarge Dense controls to Comfortable dimensions merely to create a single scale.

### 2.3 Shared rich text is a display primitive, not a universal editor

User-authored long text may share one safe Markdown/TeX renderer while retaining context-specific density and editing behavior.

- **Document mode** belongs to Project Reading. It uses full reading spacing, semantic headings, tables, code, TeX, links, and ordinary Markdown images.
- **Comment mode** belongs to ready Sample notes, process Comments, and Comment/image Timeline events. It preserves single line breaks, uses compact spacing, and renders Markdown headings as local styled copy rather than adding page-outline headings.
- Comment input remains the existing textarea. Do not add WYSIWYG state, a block model, automatic background save, or a second authoritative representation merely because read-only rendering is richer.
- Uploaded images, files, and attachment links remain separate from the Comment body. Markdown image syntax is a safe link in Comment mode, not an inline preview or an attachment reference.
- Raw HTML is literal text. All callers use the shared sanitized output; no component may pass caller-supplied HTML to `dangerouslySetInnerHTML`.
- Keep the renderer below lazy route/component boundaries. Project Map and comment-free views should not eagerly load Marked/Temml.

### 2.4 Reading rhythm has priority over numerical uniformity

Normal pages should retain visible separation between fields, cards, and sections.

| Relationship | Comfortable | Compact | Dense |
| --- | --- | --- | --- |
| Label → value/control | 6–8 px | 4–7 px | 2–5 px |
| Field → field | 12–18 px | 8–12 px | 4–9 px |
| Card internal grouping | 14–24 px | 10–16 px | 6–12 px |
| Major section separation | 26–42 px | 18–30 px | context-specific |

Do not reduce line-height or vertical spacing simply to shorten a card.

### 2.5 Natural layout is the baseline

Default, read-only, or collapsed states should use their natural content height. Do not introduce a large fixed minimum height merely to hide a transition difference.

When an edit state must remain geometrically stable, prefer structural parity or a structural mode stack over runtime DOM measurement.

## 3. Typography roles

| Role | Baseline | Rule |
| --- | ---: | --- |
| Page title | 34–52 px desktop; 38 px mobile | Route identity only |
| Page lead | 17 px desktop; 15 px mobile | Short explanatory context |
| Section title | 22 px | Major page section |
| Card title | 18 px | Card/local heading |
| Body / editable value | 14 px | Normal readable value and form-control text |
| Field label | 12 px | Sentence-case data field name |
| Metadata | 12 px | Timestamp and secondary context |
| Micro metadata | 9–11 px | Dense grid, badges, uploads, technical microcopy |
| Classification label | 9–12 px | Eyebrow, kicker, badge, table heading; uppercase allowed |

### 3.1 Field labels versus classification labels

**Field labels** identify inspectable or editable data, for example `Sample name`, `Location`, `Parameters`, and `Comments`.

- use sentence case;
- normally use approximately 12 px in Comfortable contexts;
- do not add decorative letter spacing;
- retain the same role in View and Edit states.

**Classification labels** identify hierarchy or category, for example page eyebrows, card kickers, directory headings, compact badges, Process-grid micro headings, and section indices.

- uppercase and letter spacing are allowed;
- 9–12 px is appropriate depending on density.

An element being rendered as `dt` is not enough reason to make it uppercase.

### 3.2 Control typography must be explicit

A field label and the text inside its input are different roles.

New or refactored form families should explicitly set control typography instead of relying on accidental inheritance from a parent label. The approved ordinary-form pattern is approximately:

```text
Field label: 12 px
Editable value: 14 px
```

Compact and Dense forms may intentionally use smaller values, but must declare that role locally.

## 4. View/Edit behavior

View and Edit are states of one component, not independent pages.

Preferred rules:

1. keep the domain fields in a stable order;
2. keep labels visually consistent;
3. replace or overlay editable values locally;
4. keep non-editable context available when it defines the component's geometry or meaning;
5. put Save/Cancel in a predictable local area;
6. do not move unrelated neighboring components when Edit begins;
7. prevent accidental cancellation while an asynchronous save is in flight.

### 4.1 Sample-details approved pattern

Sample details uses the complete read-only view as the natural height source. During Edit:

- the read-only structure remains in normal flow but is visually hidden;
- the edit form occupies the same content area;
- Description absorbs remaining height with a 48 px minimum;
- internal scrolling is only a fallback for unusually constrained content;
- View, Edit, and Cancel retain the same outer height;
- no runtime DOM-height installer is used.

This pattern may be reused only when the hidden baseline remains semantically complete and inaccessible hidden content is handled correctly. Do not use hidden duplicate content as a generic default for every form.

### 4.2 Template-step approved pattern

Template-step editing replaces Step name, Tool, Parameters, and Comments in their existing regions. Existing diagrams and action geometry remain stable. Do not restore an appended duplicate edit form beneath read-only values.

## 5. Domain-form consistency

The same domain object should use the same field names and preferred order wherever practical.

### 5.1 Sample identity schema

Approved order:

```text
Sample code
Sample name
Status
Location
Description
```

`Pinned` follows where that field applies. Use `Location`, not a mixture of `Location` and `Current location`.

The schema applies to:

- New Sample;
- Sample details Edit;
- Split-piece editing.

### 5.2 Comfortable forms

For Sample, Template, Metrology, Settings, and similar forms:

- labels use the Field-label role;
- controls use Body/editable-value typography;
- label-to-control gap is normally 6–8 px;
- field-to-field gap is normally 12–18 px;
- textarea height follows the content role;
- optional/helper text remains visually subordinate.

### 5.3 Compact and Dense forms

Filters, picker searches, attachment micro forms, and Process-grid editing may use smaller typography and tighter spacing.

Do not apply Comfortable form selectors globally to:

- Sample filters;
- attachment-link micro forms;
- Process-grid comments;
- upload queues;
- cell action menus.

## 6. Controls and buttons

### 6.1 Protected control ladder

| Role | Baseline |
| --- | ---: |
| Standard page action | ~42 px high |
| Shell/navigation | ~36–40 px |
| Compact toolbar/filter/pagination | ~34–40 px |
| Dense Process action | ~28–32 px |
| Mobile Sample-header action | ~42 px square |

There is no universal button height.

### 6.2 Button roles

Continue using the established semantic hierarchy:

- `.button.primary` for the page's emphasized non-destructive action;
- `.button` for ordinary actions;
- `.text-button` for low-emphasis inline actions;
- danger treatment for destructive actions;
- workflow semantic treatment only where permitted by `COLOR_SYSTEM.md`.

A typography or layout cleanup must not alter action meaning or emphasis.

### 6.3 Protected groups

Do not change these as a side effect of unrelated work:

- Sample-header action grouping;
- mobile icon-button grouping;
- run-control and action-menu widths;
- Process cell action grids;
- State action geometry;
- Jump-to-current size, placement, and visibility rules.

### 6.4 Mobile iconization

When an established mobile action hides its visible label:

- preserve `aria-label` and `title`;
- maintain the existing touch target;
- do not reintroduce text only to make desktop and mobile visually identical.

## 7. Cards and surfaces

The base `.card` owns border, radius, paper surface, and shadow. Padding remains component-owned.

Typical Comfortable padding is 18–24 px. This is a valid range rather than a requirement for one exact value.

When two cards serve the same role, their heading and padding rhythm should converge. When roles differ, density may differ.

Do not introduce a new background color or border strength to compensate for weak spacing or unclear hierarchy.

## 8. Dense Process workspace

The Process grid is a deliberate exception to ordinary-page typography.

Protected characteristics include:

- cell actions around 28 px;
- State actions around 29 px;
- comment tools around 32 px;
- state/badge text around 9–10 px;
- comment body around 12 px;
- comment metadata around 9 px;
- narrow recipe columns and horizontal sample scrolling;
- sample-count-dependent column widths;
- semantic status surfaces;
- current row and section progress geometry;
- Jump-to-current behavior.

### 8.1 Column-width baseline

| Visible samples | Recipe column | Sample behavior |
| --- | ---: | --- |
| 1 | ~380 px | flexible |
| 2 | ~320 px | min ~340 px each |
| 3 | ~290 px | min ~300 px each |
| 4+ | ~270 px | ~300 px each |
| `<=1200px` | ~230 px | ~300 px each |
| `<=720px` | 88 px | 270 px with horizontal overflow |

A normal-page typography task must not change these values.

## 9. Images and attachments

Image layout must account for available width and image count, not only the one-image case.

Rules:

- use a gallery/grid when several images share a role;
- on narrow mobile content, place multi-image galleries below text rather than in a long right-side rail;
- Dense Process cells may use narrow side thumbnails when text remains readable;
- preserve aspect ratio intentionally;
- keep large viewing in the lightbox rather than expanding inline geometry;
- treat file attachments and image previews as different visual roles;
- allow explicit attachment upload of an image when the user intentionally chooses the attachment path.

Established contextual sizes are documented in `FRONTEND_AUDIT.md`; do not force one universal thumbnail size.

## 10. Responsive rules

Primary breakpoints are:

- `1200px` for intermediate desktop/tablet reflow;
- `720px` for mobile transformation.

Add another breakpoint only when measured failure remains after considering:

- `minmax`;
- wrapping;
- grid auto-fit/auto-fill;
- intrinsic sizing;
- content reordering;
- container width;
- horizontal scrolling for intentionally wide workspaces.

Responsive changes should preserve semantic priority rather than pixel identity. It is acceptable for:

- header actions to wrap or become icon-only;
- directory headings to collapse into row structure;
- multi-sample grids to scroll horizontally;
- image galleries to move below text;
- dialog padding to reduce;
- touch targets to remain large while labels disappear.

## 11. Dialogs, drawers, menus, and lightboxes

Overlay width is task-specific. Do not normalize all overlays to one modal width.

Ordinary application overlays should use the shared `useModalDialog` behavior where applicable:

- intentional initial focus;
- Escape close;
- focus containment;
- background scroll locking;
- focus restoration;
- busy-state close blocking;
- nested-overlay stack awareness.

### 11.1 Destructive confirmation

Ordinary destructive flows should use `ConfirmDeleteDialog` rather than browser-native `window.confirm()`.

The remaining native confirmation in the Process-plan comment draft guard is a deliberate synchronous close interceptor. It must block an Escape/backdrop attempt before the parent overlay closes. Do not replace it with an asynchronous dialog unless the close architecture is redesigned first.

### 11.2 State mismatch

State mismatch uses an in-application dialog and remains bound to the exact current sample, run, and step. `State verified` remains a direct action.

### 11.3 Image lightbox

The image lightbox intentionally retains specialized keyboard behavior for:

- Escape;
- previous/next navigation;
- zoom controls;
- pan interaction.

Do not force it into the ordinary modal hook unless all specialized behavior and nested-overlay interactions are preserved.

## 12. CSS ownership

### 12.1 Global layers

Current global load order:

1. `styles.css` — tokens, shared primitives, legacy route layout, Process workspace/grid, responsive rules;
2. `palette.css` — color-role and semantic-color behavior;
3. `comment-layout.css` — focused comment geometry and compatibility rules;
4. `sample-page-layout.css` — Sample-page View/Edit and Notes media layout;
5. `processing-form-roles.css` — explicit Processing form typography roles.

`rich-text.css` is loaded with the shared `RichText` component rather than as an application-shell layer. It owns document/comment typography and MathML overflow; host layouts continue to own width, grid placement, truncation, and attachment geometry.

### 12.2 Component- and route-scoped owners

Current focused owners include:

- `sample-identity-form.css`;
- `template-page-layout.css`;
- `metrology-template-form.css`;
- `split-sample-dialog.css`;
- `modal-form-controls.css`.

### 12.3 Ownership rules

- `sample-page-layout.css` is now the formal owner of Sample-page layout refinements, not a temporary height hack.
- `comment-layout.css` remains a compatibility layer until CommentCard/CommentComposer is deliberately refactored.
- Do not create a new single-bug stylesheet without an owner and tests.
- Do not consolidate CSS through a mass selector move.
- Move rules only as part of a component-led refactor with before/after verification.
- Avoid later files whose only purpose is to cancel an earlier selector.

## 13. Protected layout invariants

Unless explicitly targeted, preserve:

- page-level button roles and target sizes;
- Sample-header action grouping;
- mobile icon-button grouping;
- generous Comfortable-page line-height and section spacing;
- Sample-details natural View height behavior;
- Notes & observations mobile image grid;
- the separation between Comment body rendering and existing image/file/link attachment controls;
- Process-grid density and column-width logic;
- run controls and action-menu geometry;
- Jump-to-current geometry and behavior;
- task-specific dialog widths;
- FileDropzone Standard/Compact dimensions;
- image-lightbox interaction area;
- status-pill color mapping and intensity;
- current `1200px` and `720px` breakpoint strategy.

## 14. Measurement protocol

### 14.1 Viewport matrix

At minimum inspect the widths relevant to the changed component:

- 1440 px ordinary desktop;
- 1024 px intermediate layout;
- 390 px common mobile;
- 360 px narrow mobile;
- 320 px minimum-width stress case where applicable;
- 1600–1920 px for wide multi-sample Processing.

### 14.2 Content matrix

Use representative stress cases:

- short and long Sample names;
- empty and multiline descriptions;
- no parent, one parent, and many children;
- 0, 1, 3, and many images;
- attachment-only and mixed media notes;
- 1, 2, 3, 4, and many Process samples;
- long Template and step content;
- empty, normal, loading, saving, and error states;
- light and dark themes.

### 14.3 Geometry to record

Record only dimensions relevant to the task:

- outer component width/height;
- primary control height;
- action-group wrapping;
- card padding;
- label/value spacing;
- image area;
- text wrapping;
- neighboring component position during state changes.

Do not chase pixel equality that has no effect on hierarchy or interaction.

## 15. Verification and merge requirements

All frontend changes must run:

```text
npm test
npm run build
```

The repository `Verify` workflow runs:

```text
npm ci
npm test
npm run build
```

on non-`main` branch pushes and pull requests targeting `main`.

A frontend PR should not merge until the Verify job passes. A source-level regression test should protect the intended role or geometry without depending on irrelevant whitespace or formatting.

## 16. Review checklist

Before merging a frontend change:

1. State the concrete problem being solved.
2. Identify Comfortable, Compact, or Dense for every affected surface.
3. Confirm protected buttons and controls were not globally resized.
4. Confirm field and classification labels remain distinct roles.
5. Confirm control text does not accidentally inherit label typography.
6. For View/Edit UI, compare field order, label treatment, outer height, and neighboring layout.
7. Test relevant desktop, intermediate, and mobile widths.
8. Test long text and multi-image cases.
9. Check light and dark themes.
10. Preserve Process-grid density unless it is the explicit target.
11. Preserve semantic colors and action-result mapping.
12. Confirm Escape, backdrop, focus, and busy behavior for overlays.
13. Run the full repository verification.
14. Update `FRONTEND_AUDIT.md` only when the established baseline materially changes.

## 17. Freeze policy

There is no active mandate for further broad frontend normalization.

After this baseline:

- do not perform global typography, spacing, button, or CSS-file consolidation passes without a concrete issue;
- prefer observation and real-use feedback over speculative cleanup;
- make future changes component by component;
- preserve mature geometry outside the stated scope;
- update these guidelines only when a design rule changes, not for every local bug fix.

The interface should now evolve through evidence-driven improvements rather than continued general normalization.