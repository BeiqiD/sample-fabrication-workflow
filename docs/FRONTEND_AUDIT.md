# Frontend component audit

Baseline date: **2026-08-07**  
Baseline `main`: **`871d1506b161796df7fbb9b6ba22faf676ec3e53`**

This document records the current frontend structure and measured CSS geometry before a broader normalization pass. It is descriptive: [`FRONTEND_GUIDELINES.md`](./FRONTEND_GUIDELINES.md) is the normative document.

No production code change is implied by an audit finding. The purpose is to distinguish mature layout decisions from accidental inconsistency so later changes can be local and measurable.

## Method

Measurements in this audit come from the effective component markup and CSS rules on the baseline commit. They are **source-level measurements**, not claims that every browser will render an identical physical pixel height after font metrics and wrapping are applied.

The audit focuses on values that materially affect layout:

- viewport/content widths;
- typography roles;
- control target heights;
- card/form padding and gaps;
- responsive breakpoints;
- image/gallery dimensions;
- view/edit structure;
- overlay widths;
- Process-grid density.

## Current stylesheet architecture

The application currently loads frontend CSS in this order:

1. `src/styles.css`
2. `src/palette.css`
3. `src/comment-layout.css`
4. `src/sample-page-layout.css`

### Ownership assessment

| File | Current role | Assessment |
| --- | --- | --- |
| `styles.css` | Tokens, shared primitives, route layouts, Process grid, dialogs, forms, responsive rules | **Primary owner**; very broad |
| `palette.css` | Interface palette roles and color-behavior overrides | **Preserve**; paired with `COLOR_SYSTEM.md` |
| `comment-layout.css` | Drop wording and Common-comment layout corrections | **Compatibility layer**; keep until owning rules are consolidated |
| `sample-page-layout.css` | Sample-detail typography parity and mobile note-image correction | **Compatibility layer**; keep until Sample page is structurally refactored |

The current layering works, but another new override stylesheet should require a clear architectural reason.

## Existing global scale

### Typography tokens

The root currently defines:

| Token/role | Value |
| --- | ---: |
| `--font-label` | 11 px |
| `--font-meta` | 12 px |
| `--font-body` | 14 px |
| `--font-card-title` | 18 px |
| `--font-section-title` | 22 px |
| Page `h1` | `clamp(34px, 5vw, 52px)` |
| Mobile `h1` | 38 px |
| Page lead | 17 px desktop / 15 px mobile |
| Eyebrow | 12 px uppercase |

The hierarchy itself is coherent. Most inconsistency occurs below the Card-title level in field labels and controls.

### Page geometry

| Role | Current measurement |
| --- | --- |
| Standard content width | 1180 px max |
| Standard page horizontal inset | 20 px each side via `calc(100% - 40px)` |
| Standard page top/bottom padding | 54 / 80 px |
| Mobile page horizontal inset | 14 px each side via `100% - 28px` |
| Mobile page top padding | 34 px |
| Narrow form page max width | 650 px |
| Wide Processing workspace | `min(1740px, 90vw)` |
| Top bar | 68 px desktop / 56 px mobile |
| Primary responsive breakpoints | 1200 px and 720 px |

### Base card geometry

The base `.card` owns a 1 px line, 14 px radius, paper surface, and low shadow. It intentionally does not force one padding value.

Observed Comfortable-card padding generally falls between **18 and 24 px**:

- Sample facts: 22 px;
- Sample Notes: 22 px desktop, 16 px mobile;
- Current structure: 18 px;
- New Sample form: 24 px;
- Template metadata / Metrology form: 20 px;
- Timeline page: 24 px desktop, 16 px mobile;
- Export archive: 24 px;
- Step edit form: 16 px nested surface.

This spread is role-based rather than inherently problematic.

## Control-size inventory

The interface already has a functional size ladder.

| Component / selector | Height / target | Density | Status |
| --- | ---: | --- | --- |
| `.button` | min 42 px | Comfortable | **Preserve** |
| Top navigation link | min 40 px | Shell | **Preserve** |
| Theme toggle | 36 px | Shell | **Preserve** |
| Full search input | 54 px | Comfortable | **Preserve** |
| Compact search | 46 px | Compact | **Preserve** |
| Filter input/select | 40 px | Compact | **Preserve** |
| `.compact-button` | min 34 px | Compact | **Preserve** |
| Pagination button | min 36 px | Compact | **Preserve** |
| Segmented option | min 36 px | Compact | **Preserve** |
| Run picker / menu trigger | 42 px | Compact workspace | **Protected** |
| Drawer close | 40 × 40 px | Overlay | **Preserve** |
| Mobile header icon action | 42 × 42 px | Mobile | **Protected** |
| Grid scroll button | 34 × 34 px | Dense | **Protected** |
| Comment tool | 32 × 32 px | Dense | **Protected** |
| Cell action | min 28 px | Dense | **Protected** |
| State-panel action | min 29 px | Dense | **Protected** |
| Mobile recipe action | 28 × 28 px | Dense | **Protected** |
| Jump to current | 28 × 28 px | Dense floating | **Protected** |

### Conclusion

There is no evidence that the application needs one universal button height. The current ladder maps well to the three density profiles. Future normalization should protect these sizes unless an explicit interaction problem is found.

## Form typography inventory

The principal inconsistency is not card size; it is that several form families establish their own label size while global controls inherit the surrounding font unless a more specific rule overrides it.

| Form/context | Label | Field gap | Control text | Assessment |
| --- | ---: | ---: | --- | --- |
| New Sample `.form-grid` | 14 px | 18 px fields; 8 px label→control | inherits 14 px | **Normalize** |
| Sample details edit | 12 px | 13 px fields; 6 px label→control | explicitly 14 px in compatibility CSS | **Typography mostly aligned; structure follow-up** |
| Template step edit | 12 px | 12 px fields; 6 px label→control | inherits label unless otherwise styled | **Normalize** |
| Template metadata edit | 12 px | 16 px groups; 6 px label→control | inherits | **Normalize** |
| Metrology template | 12 px | 14 px fields; 6 px label→control | inherits | **Normalize** |
| Split Sample setup/pieces | 13 px | 14–16 px grid; 7 px label→control | inherits | **Normalize** |
| Drawer form | 12 px | 14 px fields; 6 px label→control | inherits | **Compact/comfortable boundary; review locally** |
| Sample filters | 11 px | 12 px grid; 6 px label→control | explicit 13 px | **Preserve compact role** |
| Attachment-link micro form | 9 px | 6 px group; 3 px label→control | explicit 11 px | **Preserve Dense role** |

### Finding

A global change to `input, textarea, select` would be risky because controls currently participate in multiple density profiles. The safer long-term direction is to make form families explicitly declare their control typography.

## Read-only field inventory

### Sample details

Effective compatibility styling now uses:

- field label: 12 px, sentence case, no letter spacing;
- value: 14 px;
- label/value rhythm aligned with the edit form.

However the markup is still structurally different between view and edit:

**View:** Location, Sample code, Sample name, Status, Pinned, Parent, Children, Created, Delete area.  
**Edit:** Sample code, Sample name, Description, Status, Location, Pinned, Save.

A runtime height helper currently matches Edit height to the natural View height. This is an effective compatibility fix, but it is evidence that long-term view/edit parity is still incomplete.

**Classification:** `structural follow-up`.

### Template step

Read-only `Parameters / Comments` currently use:

- label: 10 px uppercase with letter spacing;
- value: 13.5 px;
- mobile label/value: 9 / 12.5 px.

Edit mode appends a separate Step form below the existing read-only content with 12 px sentence-case labels. The same Parameters/Comments therefore remain visible above their editable copies.

**Classification:** `structural follow-up`, highest-value next parity target.

### Initial substrate / transition technical details

Technical `dl` blocks use approximately 12 px text with uppercase muted labels in a narrow two-column layout.

This is closer to a compact technical summary than an editable field list and does not need to be normalized automatically with Sample-detail fields.

**Classification:** `preserve unless readability problem appears`.

## Domain-form consistency

### Sample identity appears in three forms

Current field order:

- **New Sample:** Code → Name → Status → Current location → Description
- **Sample details Edit:** Code → Name → Description → Status → Location → Pinned
- **Split piece:** Code → Name → Status → Location → Description

Label naming also differs (`Current location` versus `Location`).

This is a semantic consistency issue independent of typography.

**Classification:** `normalize`, but only when these forms are deliberately refactored. Do not globally reorder fields through CSS.

## Route/component classification

| Surface | Representative implementation | Density | Assessment |
| --- | --- | --- | --- |
| App shell/navigation | `App.tsx` | Shell / Compact | **Preserve** |
| Samples directory | `SamplesPage.tsx` | Comfortable + Compact rows/filter | **Mostly preserve** |
| Processing directory | `ProcessingPage.tsx` | Comfortable + Compact rows | **Mostly preserve** |
| Templates directory | `TemplatesPage.tsx` | Comfortable + Compact rows | **Mostly preserve** |
| New Sample | `NewSamplePage.tsx` | Comfortable | **Normalize form role later** |
| Sample overview | `SamplePage.tsx` | Comfortable | **View/edit structural follow-up** |
| Sample timeline | `SampleTimelinePage.tsx` / timeline components | Comfortable + Compact metadata | **Preserve** |
| Process workspace shell | `ProcessingWorkspacePage.tsx` | Compact | **Protected geometry** |
| Multi-sample Process grid | `MultiSampleRunGrid.tsx` | Dense | **Protected geometry/density** |
| Process-grid comments/uploads | `CommentComposer` and related components | Dense | **Protected; local fixes only** |
| Process template detail | `TemplatePage.tsx` | Comfortable | **Step view/edit structural follow-up** |
| Metrology template detail | `MetrologyTemplatePage.tsx` / `MetrologyTemplateForm` | Comfortable | **Low-risk typography normalization candidate** |
| Split Sample | `SplitSampleDialog.tsx` | Comfortable dialog | **Form normalization candidate** |
| Delete confirmation | `ConfirmDeleteDialog.tsx` | Compact dialog | **Preferred destructive primitive** |
| File drop | `FileDropzone.tsx` | Comfortable / Compact | **Preserve** |
| Export | `ExportPage.tsx` | Comfortable | **Preserve** |

## Sample-page measurements

The Sample overview uses a two-column priority layout on desktop:

| Element | Current measurement |
| --- | --- |
| Details/sidebar column | 280–320 px |
| Gap to Notes | 28 px |
| Facts card padding | 22 px |
| Sidebar internal gap | 16 px |
| Current-structure card padding | 18 px |
| Structure thumbnail | 96 × 72 px |
| Notes card padding | 22 px desktop / 16 px mobile |
| Note composer padding | 14 px |
| Note composer gap | 7 px |
| Notes list top separation | 20 px |

### Note images

Desktop note images currently use compact right-side previews around **92 × 72 px**. The later Sample-page compatibility stylesheet overrides the old mobile right-rail rule and instead uses a full-width adaptive grid with `minmax(84px, 1fr)` and a 4:3 aspect ratio.

**Classification:** current mobile behavior is `preserve`.

## Directory measurements

### Samples directory

- row minimum height: 82 px;
- desktop column heading: 11 px uppercase;
- row metadata: 12 px;
- mobile hides the heading row and restructures each item into content groups.

This is an appropriate use of uppercase because the text is a table/directory classification header rather than a data field label.

### Processing directory

- desktop row minimum height: 122 px;
- state thumbnail column: 120 px desktop; 92 px on mobile;
- supporting metadata: 12 px;
- run status: 11 px tonal badge.

**Classification:** `preserve`.

## Template measurements

### Template-family / version directory

- family heading padding: approximately 18–20 px;
- version row minimum height: 70 px;
- version identity: 16 px;
- supporting labels: 11 px;
- facts: 13 px.

### Metrology directory

- row minimum height: 82 px;
- supporting label: 11 px;
- summary value: 13 px.

The two directory families are already close in density and hierarchy.

**Classification:** `preserve`.

### Process template step

- card padding: 18 px desktop; 14 × 12 px mobile;
- step number: 34 px desktop; 28 px mobile;
- technical detail label/value: 10 / 13.5 px desktop; 9 / 12.5 px mobile;
- nested edit form: 16 px padding, 12 px gap, 12 px labels.

The component is visually coherent in either state individually, but view/edit parity is weak because the edit UI is appended rather than substituted.

## Process-workspace measurements

### Page and run controls

- wide page: `min(1740px, 90vw)`;
- run-control grid padding: 12 × 14 px;
- run picker/control height: 42 px;
- run action menu trigger: 42 px;
- run action item minimum height: 42 px;
- action-item title/meta: 12 / 10 px.

At mobile widths the run control preserves a 40 px select and 46 px menu-trigger width, with text labels hidden where needed.

**Classification:** `protected geometry`.

### Multi-sample grid width model

Desktop defaults:

| Visible samples | Recipe column | Sample column / width behavior |
| --- | ---: | --- |
| 1 | 380 px | flexible; grid max around 1100 px |
| 2 | 320 px | min 340 px each |
| 3 | 290 px | min 300 px each |
| 4+ | default around 270 px | default sample width around 300 px |

Intermediate (`<=1200px`) uses approximately 230 px recipe / 300 px sample columns.

Mobile (`<=720px`) uses **88 px recipe / 270 px sample** columns and horizontal overflow for multi-sample grids.

These numbers encode actual multi-sample usability and must not be changed as a side effect of general frontend normalization.

### Dense grid type/control baseline

| Role | Current measurement |
| --- | ---: |
| Cell state text | 10 px |
| State icon | 22 px |
| Cell comment body | 12 px |
| Comment metadata | 9 px |
| Cell action | min 28 px, 10 px text |
| State action | min 29 px, 10 px text |
| Comment textarea | min 32 px, 12 px text |
| Comment tool | 32 × 32 px |
| Verification badge | 9 px |
| Upload queue labels/actions | mostly 9–11 px |

**Classification:** `protected Dense system`.

## Overlay inventory

Overlay widths already scale with task complexity and should remain role-specific.

| Overlay | Current width | Padding | Assessment |
| --- | ---: | ---: | --- |
| Confirm delete | max 440 px | 22 px | **Preferred destructive primitive** |
| Step / picker drawer | max 520 px | 24 px desktop / 18 px mobile | **Preserve** |
| Process-plan comment sheet | max 620 px | 18 px | **Preserve** |
| Standalone metrology dialog | max 640 px | inherited dialog family | **Preserve** |
| Split Sample | max 760 px | 24 px desktop / 18 px mobile | **Preserve width; normalize fields later** |
| Start-process dialog | max 820 px | 24 px desktop / 18 px mobile | **Preserve** |
| Transition-template dialog | max 860 px | task-specific | **Preserve** |

### Behavior inconsistency

`ConfirmDeleteDialog` provides a real application dialog pattern, including focus handling and optional typed confirmation. Some Template and Metrology deletion flows still use browser-native `window.confirm()`.

**Classification:** `behavior normalization candidate`. Widths do not need to be unified.

## Media and upload measurements

| Component | Current measurement | Assessment |
| --- | --- | --- |
| Standard FileDropzone | min 168 px; 24 px padding | **Preserve** |
| Compact FileDropzone | min 92 px; 12 × 14 px padding | **Preserve** |
| Selected-file preview | 64 × 64 px | **Preserve** |
| Normal grid photo thumbnail | 48 × 48 px | Density-specific |
| Common execution comment | 72 × 58 px stacked gallery | **Preserve local fix** |
| Sample Note mobile gallery | adaptive min 84 px cells, 4:3 | **Preserve** |
| Template initial-state preview | 200 × 104 px desktop; 108 × 76 px mobile | **Preserve unless media task targets it** |

Image sizing is currently context-sensitive. A future media primitive should preserve this distinction rather than force one universal thumbnail size.

## Responsive inventory

### 1200 px breakpoint

Used primarily for intermediate desktop/tablet reflow:

- hide brand title;
- reduce directory columns;
- stack some header layouts;
- reduce Process recipe width to around 230 px;
- simplify Template/Metrology directory rows.

### 720 px breakpoint

Used for true mobile transformation:

- top bar 56 px and icon navigation;
- page inset becomes 14 px;
- page headers stack;
- primary Sample actions become 42 px icon buttons;
- directory headings disappear;
- Process recipe column shrinks to 88 px;
- dialog padding reduces;
- Template-step dimensions shrink;
- FileDropzone compact mode stacks;
- image galleries may change layout.

The breakpoint strategy is currently simple and should be preserved.

## CSS compatibility overrides

### `comment-layout.css`

Current responsibilities:

- change comment drop overlay wording to `Drop images or attachments`;
- stack Common execution comment text and thumbnails in the narrow Process-plan column;
- set Common thumbnails to approximately 72 × 58 px.

This file is a local compatibility layer and should not become a general-purpose component stylesheet.

### `sample-page-layout.css`

Current responsibilities:

- normalize Sample-detail view/edit label/value typography;
- support runtime Edit-height locking without a fixed View min-height;
- convert mobile Note images from the legacy right rail into an adaptive full-width grid.

The typography and mobile gallery rules are valid behavior. The runtime height lock should become unnecessary if Sample-details view/edit markup is eventually made structurally parallel.

## Findings by priority

### A — Structural parity, high value

#### A1. Template-step view/edit parity

Why it matters:

- same data appears twice during Edit;
- label typography changes between view and edit;
- edit expansion changes card geometry substantially.

Recommended future direction: keep one field layout and replace values in place.

Risk: medium because images, delete actions, and mobile layout share the card.

#### A2. Sample-details markup parity

Current typography and height behavior are now acceptable, but the view and edit field sets still differ.

Recommended future direction: keep Parent/Children/Created visible while editable fields switch in place; consider a stable local action area for Save/Cancel.

Risk: medium. Do not undo the natural-height baseline while refactoring.

### B — Form-role normalization, medium value

#### B1. Sample Create / Edit / Split schema

Normalize field names/order and explicitly separate label typography from control typography.

Risk: low to medium; avoid changing action/button layout.

#### B2. Template / Metrology form control typography

Explicitly establish control text size rather than relying on label inheritance.

Risk: low if done per form family and geometry is measured before/after.

### C — Behavior primitive consistency

#### C1. Destructive confirmation

Prefer the shared in-app confirmation dialog for remaining browser-native delete confirmations.

Risk: medium because focus/backdrop/async states need correct handling.

### D — CSS ownership cleanup

Move stable compatibility rules toward owning components when those components are deliberately refactored. Do not start with a mass selector rewrite.

Risk: high if attempted globally; low when paired with a component refactor.

## Explicit preserve list

The audit found no current reason to normalize these systems globally:

- Button geometry and variants;
- mobile Sample-header icon grouping;
- Samples and Processing directory row density;
- Process workspace run controls;
- MultiSampleRunGrid density and width calculations;
- Jump to current geometry;
- status-pill color system;
- Process-grid status surfaces;
- FileDropzone standard/compact sizes;
- task-specific dialog widths;
- current mobile Notes image grid;
- generous Comfortable-page line-height and section spacing.

## Recommended implementation sequence

When moving beyond this documentation baseline, use this order:

1. **Template-step view/edit parity** — one contained component with a clear current mismatch.
2. **Sample identity form schema** — align Create / Edit / Split names, order, and explicit typography while preserving buttons.
3. **Sample-details structural parity** — simplify/remove runtime sizing once markup can naturally match.
4. **Metrology/Template form typography** — explicit control roles, low-risk local cleanup.
5. **Destructive confirmation behavior** — replace remaining `window.confirm()` flows with the shared primitive.
6. **CSS ownership cleanup** — only after the affected components have stabilized.

Do not begin with a global typography, button, or spacing rewrite.

## Measurement checklist for each follow-up

For every component refactor above, capture before/after at relevant widths:

- outer card/component width and height;
- control height and action-group wrapping;
- field label/value positions;
- neighboring component top position before/after state change;
- long-text wrapping;
- 0/1/many image behavior;
- mobile 390 px and 360 px layout;
- light/dark appearance.

The refactor is successful when the target inconsistency improves **without moving unrelated mature geometry**.
