# Frontend implementation baseline

Status: **frozen reference baseline**  
Baseline date: **2026-08-07**  
Code baseline: **`main` at `f7eeb932c0b6771dc2d6471077447b2297bf9017`**  
Normative rules: [`FRONTEND_GUIDELINES.md`](./FRONTEND_GUIDELINES.md)  
Color rules: [`COLOR_SYSTEM.md`](./COLOR_SYSTEM.md)

This document records the frontend state after the 2026-08 normalization pass. It is a reference snapshot, not an automatic backlog. A difference from another component is not, by itself, a reason to change production UI.

Future frontend work should be driven by a concrete usability, accessibility, responsive-layout, or maintainability problem. Changes should remain local, measured, and compatible with the protected geometry below.

## Baseline status

The normalization pass is complete for the component families it targeted:

| Area | Current baseline |
| --- | --- |
| Template-step View/Edit | Editing replaces values in place; duplicate read-only/edit copies were removed |
| Sample identity forms | Create, Sample Edit, and Split-piece forms use one field naming/order model |
| Template and Metrology forms | Label and editable-value typography are explicitly separated |
| Destructive actions | Ordinary deletion flows use the application confirmation dialog |
| Split Sample | Setup and piece forms use the Comfortable form role without changing dialog geometry |
| Processing forms | Drawer controls, run picker, and process-family search use explicit role typography |
| Modal behavior | Ordinary dialogs and drawers share focus, Escape, scroll-lock, and focus-restoration behavior |
| State mismatch | Browser `prompt()` was replaced with an in-application dialog bound to the exact run step |
| Process-grid overlays | Recipe details, comment sheets, Step drawer, and Metrology picker use the shared modal behavior |
| Modal form controls | Compact labels and 14 px editable values are explicitly separated |
| Sample details | Natural View height is the baseline; Edit is structurally overlaid within that exact geometry |
| Verification | Branch pushes and pull requests run install, full tests, and the production build |

The related implementation work was completed across PRs **#102–#114**. PR #113 was a TypeScript build hotfix; PR #114 established the final Sample-details structure and verification baseline.

## Current stylesheet architecture

### Global load order

`src/main.tsx` loads the global layers in this order:

1. `styles.css`
2. `palette.css`
3. `comment-layout.css`
4. `sample-page-layout.css`
5. `processing-form-roles.css`

### Component- or route-scoped owners

The current code also imports focused styles from their owning components or routes:

| File | Owner / purpose | Status |
| --- | --- | --- |
| `sample-identity-form.css` | Shared Sample identity field roles | **Stable owner** |
| `template-page-layout.css` | Process Template detail and step View/Edit layout | **Stable owner** |
| `metrology-template-form.css` | Metrology Template form roles | **Stable owner** |
| `split-sample-dialog.css` | Split Sample dialog geometry and field roles | **Stable owner** |
| `modal-form-controls.css` | Typed confirmation and State-mismatch editable-value typography | **Stable owner** |

### Ownership assessment

| File | Current role | Assessment |
| --- | --- | --- |
| `styles.css` | Tokens, shared primitives, legacy route layout, Process workspace/grid, and responsive rules | **Broad primary owner; change carefully** |
| `palette.css` | Color roles and semantic-color behavior | **Preserve; governed by `COLOR_SYSTEM.md`** |
| `comment-layout.css` | Comment drag/drop wording and Common-comment narrow-column layout | **Compatibility layer; preserve until the comment component is deliberately refactored** |
| `sample-page-layout.css` | Sample-page View/Edit geometry, typography parity, and mobile Notes image layout | **Formal Sample-page owner** |
| `processing-form-roles.css` | Explicit typography roles for Processing form controls | **Focused shared role layer** |

Do not add another override stylesheet for a single visual discrepancy without defining its owner, scope, tests, and eventual removal or long-term ownership.

## Frozen density model

The interface intentionally uses three densities.

| Density | Representative surfaces | Type range | Control range | Baseline decision |
| --- | --- | ---: | ---: | --- |
| **Comfortable** | Sample details, ordinary forms, Template details, Settings/Export, major dialogs | labels ~12 px; values/body ~14 px | ~40–42 px | Preserve generous reading rhythm |
| **Compact** | Filters, pickers, directory rows, toolbars, pagination | mostly 11–13 px | ~34–40 px | Preserve information efficiency |
| **Dense** | Process grid, inline execution comments, upload queues, cell actions | mostly 9–12 px | ~28–32 px | Protected workspace system |

These are role profiles, not values to collapse into one universal scale.

## Typography baseline

### Root hierarchy

| Role | Baseline |
| --- | ---: |
| Page title | `clamp(34px, 5vw, 52px)`; 38 px mobile |
| Page lead | 17 px desktop; 15 px mobile |
| Section title | 22 px |
| Card title | 18 px |
| Body / editable value | 14 px |
| Field label | 12 px, sentence case |
| Metadata | 12 px |
| Dense micro metadata | 9–11 px |
| Eyebrow / classification label | 9–12 px, uppercase allowed |

Normal field labels and classification labels are different roles. Uppercase and letter spacing remain appropriate for eyebrows, badges, table headings, and Dense technical labels, but not for ordinary Sample/Template form fields.

### Form-role baseline

| Family | Current rule |
| --- | --- |
| Sample Create / Edit / Split piece | Canonical order: Sample code → Sample name → Status → Location → Description; Pinned follows where applicable |
| Sample details View/Edit | 12 px labels and 14 px values/controls in both states |
| Template step | One View/Edit field structure; readable values and controls remain aligned |
| Metrology Template | 12 px labels / 14 px controls |
| Processing Step drawer | 12 px labels / 14 px controls |
| Run selector | 14 px editable and read-only value role |
| Process-family search | 14 px within its existing compact geometry |
| Filters | 11 px labels / 13 px controls; intentionally Compact |
| Attachment micro forms | 9 px labels / 11 px controls; intentionally Dense |

## Protected control geometry

| Component / role | Baseline |
| --- | ---: |
| Standard `.button` | min 42 px |
| Top navigation | min 40 px |
| Theme toggle | 36 px |
| Full search input | 54 px |
| Compact search | 46 px |
| Filter input/select | 40 px |
| Compact button | min 34 px |
| Pagination / segmented option | min 36 px |
| Run picker / menu trigger | 42 px |
| Drawer close control | 40 × 40 px |
| Mobile Sample-header action | 42 × 42 px |
| Grid scroll control | 34 × 34 px |
| Comment tool | 32 × 32 px |
| Process cell action | min 28 px |
| State-panel action | min 29 px |
| Mobile recipe action | 28 × 28 px |
| Jump to current | 28 × 28 px |

There is no approved global button-height normalization. A task must explicitly target a control family before these dimensions change.

## Responsive baseline

Primary breakpoints remain:

- **1200 px**: intermediate desktop/tablet reflow;
- **720 px**: mobile transformation.

Do not add another breakpoint until intrinsic layout options have been exhausted and a measured failure remains.

### Page geometry

| Role | Baseline |
| --- | --- |
| Standard content width | 1180 px max |
| Standard horizontal inset | 20 px per side |
| Mobile horizontal inset | 14 px per side |
| Standard page padding | 54 px top / 80 px bottom |
| Mobile page top padding | 34 px |
| Narrow form page | 650 px max |
| Wide Processing workspace | `min(1740px, 90vw)` |
| Top bar | 68 px desktop / 56 px mobile |

### Multi-sample Process-grid width model

| Visible samples | Recipe column | Sample column behavior |
| --- | ---: | --- |
| 1 | ~380 px | flexible; grid max around 1100 px |
| 2 | ~320 px | min ~340 px each |
| 3 | ~290 px | min ~300 px each |
| 4+ | ~270 px | default ~300 px each |
| `<=1200px` | ~230 px | ~300 px each |
| `<=720px` | **88 px** | **270 px**, horizontal overflow |

This width model and the Process-grid Density are protected.

## Component-family baseline

| Surface | Density | Baseline status |
| --- | --- | --- |
| App shell/navigation | Shell / Compact | Preserve |
| Samples directory | Comfortable + Compact | Preserve current row and filter density |
| Processing directory | Comfortable + Compact | Preserve |
| Templates directory | Comfortable + Compact | Preserve |
| New Sample | Comfortable | Canonical Sample identity form |
| Sample overview | Comfortable | Structurally stable View/Edit; preserve natural View height |
| Sample timeline | Comfortable + Compact metadata | Preserve |
| Template detail | Comfortable | Step View/Edit normalized; preserve diagram and action geometry |
| Metrology Template | Comfortable | Explicit form roles |
| Split Sample | Comfortable dialog | Explicit setup/piece form roles; preserve width and buttons |
| Process workspace shell | Compact | Protected geometry |
| Multi-sample Process grid | Dense | Protected density and column calculations |
| Process-grid comments/uploads | Dense | Local fixes only; no Comfortable-form normalization |
| FileDropzone | Comfortable / Compact | Preserve both established sizes |
| Export/Settings surface | Comfortable | Preserve until that route is deliberately expanded |

## Sample-details baseline

The Sample-details card now follows this structure:

- the complete read-only view remains in normal document flow and defines the natural card height;
- entering Edit hides that view visually but keeps its geometry;
- the edit form is positioned within the same content area;
- Description uses the remaining edit height with a 48 px minimum;
- internal form scrolling exists only as a fallback for unusually short or heavily wrapped cards;
- returning to View restores the identical natural height;
- there is no fixed View minimum height and no runtime DOM-height installer.

This is the approved baseline. Do not reintroduce global minimum heights or runtime measurement merely to make a new field fit.

## Images and attachments

| Context | Baseline |
| --- | --- |
| Standard grid photo | 48 × 48 px |
| Common execution comment | stacked gallery, approximately 72 × 58 px thumbnails |
| Sample Note desktop | compact contextual preview |
| Sample Note mobile | full-width adaptive grid, minimum ~84 px cells, 4:3 |
| Template initial state | 200 × 104 px desktop; 108 × 76 px mobile |
| Standard FileDropzone | min ~168 px; 24 px padding |
| Compact FileDropzone | min ~92 px; 12 × 14 px padding |
| Selected-file preview | 64 × 64 px |

Image sizing is context-sensitive. Do not force one universal thumbnail primitive across Dense grid evidence, Sample notes, and Template diagrams.

## Overlay and interaction baseline

| Overlay | Width baseline | Decision |
| --- | ---: | --- |
| Confirmation / State mismatch | max ~440 px | Preserve |
| Step / picker drawer | max ~520 px | Preserve |
| Process-plan comment sheet | max ~620 px | Preserve |
| Standalone Metrology | max ~640 px | Preserve |
| Split Sample | max ~760 px | Preserve |
| Start Process | max ~820 px | Preserve |
| Transition Template | max ~860 px | Preserve |

Ordinary overlays use the shared `useModalDialog` behavior for:

- background scroll locking;
- Escape handling;
- focus containment;
- initial focus;
- focus restoration;
- busy-state close blocking where applicable;
- nested-overlay stack behavior.

The image lightbox intentionally retains a specialized keyboard model because it also owns previous/next and zoom shortcuts.

## Deliberate exceptions

These are not active defects:

1. **Unsaved Process-plan comment guard:** the remaining browser-native confirmation is a synchronous close guard that must be able to block Escape/backdrop dismissal before an asynchronous dialog can replace the interaction.
2. **Image lightbox:** specialized keyboard and zoom behavior remains separate from ordinary modal behavior.
3. **`comment-layout.css`:** remains a compatibility layer until CommentCard/CommentComposer is deliberately refactored.
4. **Broad `styles.css`:** remains a large legacy/shared owner; it should be reduced only through component-led work, not a mass selector move.

## Verification baseline

`.github/workflows/verify.yml` runs on non-`main` branch pushes and pull requests targeting `main`:

```text
npm ci
npm test
npm run build
```

The production build includes strict TypeScript compilation and Vite output generation.

PR #114 additionally validated Sample-details layout across:

- widths: 320, 360, 390, 768, and 1180 px;
- light and dark themes;
- short, long-wrapped, and many-child content cases.

The verified properties were:

- unchanged natural read-only height;
- equal View/Edit/Cancel heights;
- Description minimum height of 48 px;
- no normal-case internal edit scrolling;
- Delete area retained at the bottom of the natural card.

## Freeze and change gate

This baseline is considered stable. Before changing a mature component family:

1. identify a concrete user-facing or maintenance problem;
2. identify the component's density profile;
3. measure only the geometry relevant to that problem;
4. state which protected geometry must remain unchanged;
5. test representative width, content, and theme cases;
6. run the full repository verification;
7. update this audit only when the implementation baseline materially changes.

A general desire for visual uniformity is not sufficient justification for changing established buttons, spacing, breakpoints, Process-grid density, or task-specific overlay widths.

## Current open work

There is **no active broad frontend-normalization backlog** at this baseline.

Future work should be issue-driven. The most likely architecture cleanup is moving stable comment compatibility rules into an owning Comment component when that component is deliberately refactored. That should not be started as a standalone CSS consolidation project.