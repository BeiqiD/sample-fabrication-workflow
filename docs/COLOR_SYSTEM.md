# Color system

This document defines the interface and workflow color roles used by Sample Fabrication Workflow.

## Design direction

The interface is grayscale first. A small number of carefully chosen light and dark neutrals establish hierarchy; mineral indigo appears only as interaction feedback. Workflow colors remain available where color carries domain meaning.

Do not default to pure black and pure white merely to force hierarchy. Long-reading surfaces should use a comfortable text/background pair, while small icons, media controls, status foregrounds, or other roles may use pure black or white when that produces the clearest result. This is a readability decision, not a ban on either endpoint. Typography, spacing, borders, and measured differences between adjacent grays should carry most of the hierarchy.

The intended visual order is:

1. content and structure are understandable in grayscale;
2. hover, focus, open, and selected states reveal mineral indigo;
3. workflow colors identify meaningful sample, run, or step states;
4. large colored areas are concentrated in the Process grid, where they encode progress rather than decoration.

The interface palette and workflow semantic palette are intentionally separate. A future visual refresh may change interface colors, but it must not silently change the meaning of sample, run, or step states.

## Color hierarchy

Colors are assigned in four layers.

### 1. Workflow semantic colors

These colors communicate an existing state or a clear condition. They are locked unless the workflow semantics themselves change.

| Role | Meaning | Light | Dark |
| --- | --- | --- | --- |
| Success | Done, verified, or an active/healthy sample or run | `#177252` | `#5FC59A` |
| Success soft | Success background | `#E3F3EB` | `#1B382C` |
| Warning | Skipped, caution, or deviation | `#AA6B14` | `#E0A44B` |
| Warning text | Warning text on soft backgrounds | `#80500E` | `#F2C36F` |
| Warning soft | Warning background | `#FFF3D9` | `#3A2C16` |
| Danger | Blocked, mismatch, loss, or destructive action | `#A33A33` | `#E17A72` |
| Danger soft | Danger background | `#FBE7E5` | `#3B2221` |
| Info | Completed sample or run, in progress, or informational state | `#246F9A` | `#69B5DF` |
| Info soft | Informational background | `#E8F3FA` | `#1D3340` |
| Neutral | Pending or non-active state | `#68736D` | `#A4AFA8` |
| Neutral soft | Neutral state background | `#EDF0EE` | `#252D28` |

Status meanings follow the product domain rather than a universal color convention. In particular:

- `Active` is green because the sample is present and healthy; it does not mean a process is complete.
- `Complete` is blue because the sample or run has left its active phase; it is not a success action.
- `Stored`, `Consumed`, `Ready`, `Draft`, `Locked`, `Pinned`, and generic `Change` labels are neutral unless an additional condition makes them warning or danger states.

Status icon foreground contrast is independent from the interaction accent. It remains `#F7F8F6` in light mode and `#0C1611` in dark mode.

### 2. Process-grid state colors

The Process grid deliberately uses more colored surface area than the rest of the application. Its cell border, background, badge, and progress treatments let a user scan pending, in-progress, done, skipped, blocked, and additional steps quickly.

This is an information display, not a general license to tint cards or controls elsewhere. Process-grid status backgrounds must continue to use workflow tokens, while ordinary grid controls, comments, step numbers, and metrology labels start neutral.

### 3. Grayscale interface hierarchy

The grayscale system is intentionally small. Each level has a structural job rather than an independent meaning.

| Level | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#F4F5F4` | `#141719` | Page background and the lowest visual plane |
| Paper | `#FAFBFA` | `#1B1F21` | Cards, dialogs, menus, inputs, and raised content |
| Quiet surface | `#F7F8F7` | `#1F2325` | Low-emphasis grouped regions |
| Surface | `#EEF0EE` | `#22272A` | Secondary controls, row hover bases, and nested panels |
| Muted surface | `#E4E7E4` | `#2A3033` | Disabled, read-only, selected-neutral, and stronger separation |
| Standard line | `#D6DBD7` | `#383F43` | Normal boundaries |
| Strong line | `#BEC6C1` | `#515B61` | Interactive or nested boundaries |
| Ink | `#303633` | `#C9CFCC` | Main text |
| Muted ink | `#68716C` | `#969F9A` | Metadata, labels, and secondary text |
| Strong control | `#3E4541` | `#BFC6C2` | Emphasized neutral buttons and brand mark |
| Strong-control contrast | `#F7F8F6` | `#1B1F21` | Text and icons on emphasized neutral controls |

Use spacing, weight, and this limited surface ladder before introducing another gray token. The usual hierarchy is canvas → paper → surface → muted surface; not every component needs all four.

### 4. Mineral-indigo interaction color

Mineral indigo does not describe content. It means that the user is interacting with, has selected, or has focused something.

| State | Treatment |
| --- | --- |
| Default | Grayscale only |
| Hover | Indigo text or border with a very light indigo background where useful |
| Pressed | Stronger indigo treatment or a subtle pressed surface |
| Open / Selected / Current | Stable indigo text, border, or soft background; visibly stronger than hover |
| Focus-visible | Indigo focus ring |
| Disabled | Muted grayscale, no hover treatment |

The accent values are `#4F5D95` / `#E3E4F1` in light mode and `#AAB7E8` / `#29314A` in dark mode.

Titles, eyebrow labels, sample codes, step numbers, comments, ordinary badges, and inactive icons must not be permanently indigo. They are content, not interaction state.

## Control behavior

Controls use three non-semantic emphasis levels:

| Control | Default | Hover / active |
| --- | --- | --- |
| Emphasized button | Graphite fill with a softened off-white contrast | Indigo fill |
| Standard button or dropdown trigger | Paper, ink, and a standard line | Indigo text/border and soft indigo background |
| Text action or inline link | Ink or muted ink; inline links remain identifiable by underline | Indigo |

All enabled controls, including dropdown triggers, must provide hover feedback. A dropdown is identified by its caret or menu icon and by a persistent open state, not by withholding hover behavior.

The same action should use the same variant across pages. For example, every page-level `New sample` action is emphasized; it must not be indigo on one page and gray on another.

Selected filters, segmented options, picker rows, current navigation items, and open menu triggers may remain indigo until the state changes. Color is accompanied by a background, border, icon, label, or `aria-*` state so it is never the sole indicator.

## Action-result colors

An action may inherit a semantic color only when its visible result has a sufficiently clear one-to-one mapping to that color.

Current examples:

- **Done** and batch **Done · n** use success green because the affected step immediately becomes the green Done state.
- **State verified** uses success green because it creates a green Verified badge.
- **State mismatch** uses danger red because it creates a red Mismatch badge.
- Destructive actions use danger red because their consequence is destructive and persistent.

Do not apply semantic colors merely because an operation is expected to succeed. Add Sample, Add step, Start process, Save, Correct, Upload, Split, Assign, Update plan, and Export are neutral controls by default and become indigo only through interaction.

## Framework strategy

The project keeps a small internal visual system instead of adopting a fully styled component framework. A full framework would replace established layout and domain-specific Process-grid behavior without solving the underlying color-contract problem.

- Shared button, text-action, link, badge, and focus rules remain project CSS.
- Complex behavior such as Dropdown Menu, Dialog, Popover, or Select may progressively use unstyled open-source primitives when accessibility or positioning warrants it.
- Any primitive must consume the same grayscale, interaction, and semantic tokens; it must not introduce a second visual system.

## Non-component surfaces

The palette also covers surfaces that are easy to miss during a theme change:

- browser `theme-color`;
- favicon background;
- image viewer panel and toolbar;
- drawers and dialogs;
- attachment and run-action menus;
- floating shadows and overlays.

Media viewers may keep their dedicated dark controls and pure-white foregrounds where that makes imagery and controls easier to read. Those controls still need visible hover and focus feedback.

## Accessibility

Main text, muted text, and accent text/background pairs must meet at least the WCAG AA 4.5:1 contrast threshold for normal text.

Color must not be the only state indicator. Statuses also use labels, icons, borders, shapes, or position. Inline links must remain discoverable without relying only on hover color.

## Implementation rules

- Interface token overrides live in `src/palette.css` and load after `src/styles.css`.
- Shared component behavior lives in `src/styles.css`; workflow semantic token definitions remain there.
- Do not redefine workflow semantic tokens in `src/palette.css`.
- Do not use `--accent` for static content. Its allowed roles are hover, focus, open, selected, current, checked, dragging, and other explicit interaction states.
- Process-grid semantic surfaces use success, warning, danger, info, and neutral tokens rather than interface accent.
- New hard-coded interface colors should be avoided. Add a named token only when an existing structural level genuinely cannot express the role.
- Before changing the palette, inspect the full repository for hard-coded colors, shadows, browser metadata, assets, and duplicated action variants.
- Update `src/palette.test.ts` whenever a new palette role, interaction rule, or semantic action mapping is introduced.

## Review checklist

Before merging any color-system change:

1. Confirm all interface tokens have both light and dark values.
2. Confirm the grayscale hierarchy remains limited and each surface level has a distinct job.
3. Confirm static content and default non-semantic controls do not use mineral indigo.
4. Confirm every enabled button and dropdown trigger has hover feedback.
5. Confirm hover, focus, open, and selected treatments are consistent across pages.
6. Confirm identical actions, especially `New sample`, use the same variant everywhere.
7. Confirm Process-grid status coloring and `Active` green / `Complete` blue mappings remain intact.
8. Confirm action-result colors still match their resulting visible state.
9. Search for legacy hard-coded colors, tinted shadows, and default-state accent uses.
10. Check browser chrome, favicon, dialogs, drawers, menus, and media surfaces.
11. Verify contrast and ensure color is not the sole state cue.
