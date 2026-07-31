# Color system

This document defines the interface and workflow color roles used by Sample Fabrication Workflow.

## Design direction

The interface uses warm neutral surfaces with a mineral-indigo accent. The goal is to keep the application calm and precise while allowing workflow state colors to retain their meaning.

The interface palette and workflow semantic palette are intentionally separate. A future visual refresh may change interface colors, but it must not silently change the meaning of sample, run, or step states.

## Color hierarchy

Colors are assigned in three layers.

### 1. Workflow semantic colors

These colors communicate an existing state or a clear condition. They are locked unless the workflow semantics themselves change.

| Role | Meaning | Light | Dark |
| --- | --- | --- | --- |
| Success | Done, verified, active/success state | `#177252` | `#5FC59A` |
| Success soft | Success background | `#E3F3EB` | `#1B382C` |
| Warning | Skipped, caution, deviation | `#AA6B14` | `#E0A44B` |
| Warning text | Warning text on soft backgrounds | `#80500E` | `#F2C36F` |
| Warning soft | Warning background | `#FFF3D9` | `#3A2C16` |
| Danger | Blocked, mismatch, destructive action | `#A33A33` | `#E17A72` |
| Danger soft | Danger background | `#FBE7E5` | `#3B2221` |
| Info | In progress and informational state | `#246F9A` | `#69B5DF` |
| Info soft | Informational background | `#E8F3FA` | `#1D3340` |
| Neutral | Pending or non-active state | `#68736D` | `#A4AFA8` |
| Neutral soft | Neutral state background | `#EDF0EE` | `#252D28` |

Status icon foreground contrast is also independent from the interface accent. It remains `#FFFFFF` in light mode and `#0C1611` in dark mode.

### 2. Action-result colors

An action may inherit a semantic color only when its visible result has a sufficiently clear one-to-one mapping to that color.

Current examples:

- **Done** and batch **Done · n** use success green because the affected step immediately becomes the green Done state.
- **State verified** uses success green because it creates a green Verified badge.
- **State mismatch** uses danger red because it creates a red Mismatch badge.
- Destructive actions use danger red because their consequence is destructive and persistent.

Do not apply semantic colors merely because an operation is expected to succeed. Green must not become a generic submit or save color.

### 3. Interface colors

Actions with ambiguous, multi-step, reversible, or non-state-specific outcomes use the interface accent or neutral controls.

Examples include:

- Add Sample or Add step
- Start process or Start metrology
- Save changes or Save correction
- Correct
- Upload or attach
- Split
- Assign template
- Update plan
- Export

These actions modify data, but their outcome is not uniquely represented by success, warning, danger, info, or neutral.

## Interface palette

### Light mode

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#F7F8F6` | Page background |
| Paper | `#FFFFFF` | Cards, panels, inputs |
| Surface | `#F0F2F0` | Secondary surfaces |
| Surface muted | `#E8EBE8` | Muted or selected-neutral areas |
| Surface warm | `#F4F4EF` | Warm secondary surface |
| Input | `#FFFFFF` | Form controls |
| Ink | `#202522` | Main text |
| Muted | `#69716D` | Secondary text |
| Line | `#D9DEDA` | Standard borders |
| Line strong | `#C3CBC6` | Stronger borders |
| Accent | `#4F5D95` | Primary interface actions and focus |
| Accent contrast | `#FFFFFF` | Text on accent |
| Accent soft | `#E3E4F1` | Selected and hover backgrounds |

### Dark mode

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#111416` | Page background |
| Paper | `#181C1F` | Cards and panels |
| Surface | `#1F2529` | Secondary surfaces |
| Surface muted | `#262D32` | Muted or selected-neutral areas |
| Surface warm | `#1C2022` | Warm secondary surface |
| Input | `#14181A` | Form controls |
| Ink | `#EEF2F0` | Main text |
| Muted | `#9FA8A3` | Secondary text |
| Line | `#343C41` | Standard borders |
| Line strong | `#4A555C` | Stronger borders |
| Accent | `#AAB7E8` | Primary interface actions and focus |
| Accent contrast | `#111416` | Text on accent |
| Accent soft | `#29314A` | Selected and hover backgrounds |

## Non-component surfaces

The palette also covers surfaces that are easy to miss during a theme change:

- browser `theme-color`
- favicon background
- image viewer panel and toolbar
- drawers and dialogs
- attachment and run-action menus
- floating shadows and overlays

These surfaces must not retain colors or shadows from an earlier interface palette.

## Accessibility

Main text, muted text, and accent text/background pairs must meet at least the WCAG AA 4.5:1 contrast threshold for normal text.

Color must not be the only state indicator. Statuses also use labels, icons, borders, or shapes.

## Implementation rules

- Interface palette overrides live in `src/palette.css` and load after `src/styles.css`.
- Workflow semantic token definitions remain in `src/styles.css`.
- Do not redefine semantic tokens in `src/palette.css`.
- New hard-coded interface colors should be avoided. Add a named token when a new role is genuinely needed.
- Before changing the palette, inspect the full repository for hard-coded colors, shadows, browser metadata, and assets.
- Update `src/palette.test.ts` whenever a new palette role or semantic action mapping is introduced.

## Review checklist

Before merging any color-system change:

1. Confirm all interface tokens have both light and dark values.
2. Confirm semantic token values have not changed unintentionally.
3. Confirm action-result colors still match their resulting visible state.
4. Confirm ambiguous actions remain on the interface accent or neutral styling.
5. Search for legacy hard-coded colors and tinted shadows.
6. Check browser chrome, favicon, dialogs, drawers, menus, and media surfaces.
7. Verify contrast and ensure color is not the sole state cue.
