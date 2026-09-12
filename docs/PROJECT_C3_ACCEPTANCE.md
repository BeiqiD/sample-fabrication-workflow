# Phase 5C3 Reading details and responsive panels

Status: implemented on `feat/project-reading-responsive-details`, originally
stacked on PR #168 (`43539e61114022046df7c23c671f4570d2e485d3`). Initial review:
2026-09-11; extended pre-merge review: 2026-09-12. The user authorized merging both
PRs after verification. Deployment and full C4 completion remain separate work.

## Behavior

- Reading cards expose Details explicitly for Markdown, references and attachments.
  Text selection stays a reading action. One Inspector projection supplies source
  context, relationships, bounded Markdown, related-record discovery and secondary actions.
- Details → Edit closes the panel and focuses the existing inline editor. Relationship
  navigation closes Reading details and focuses the exact occurrence, including
  repeated navigation to the same target. Arrange and Pin remain Map controls.
- Desktop Map panels remain non-modal. Desktop Reading reserves document space for
  one floating contextual panel. References and Inspector share the existing state
  and commands; the 860px breakpoint still waits for pending or dirty operations.
- Mobile References, Inspector and Trash use a modal surface with background inert,
  scroll locking, bidirectional Tab containment, Escape/backdrop dismissal and
  usable return focus. Pending operations prevent dismissal. Only the top modal
  owns closing and focus; nested editors and confirmations retain that ownership.
- The leave confirmation is a separate modal above the active surface, with the
  existing Stay, Save and leave, discard, exact-retry and reconciliation actions.
- Unsubmitted reference query and filter drafts live in ProjectPage across panel
  closes and responsive remounts. Search requests still use only committed criteria.
  Browse related explicitly resets both the committed search and its draft.
- Removing the inspected card closes Reading details, preserves existing recovery
  controllers and returns focus to Add when its card trigger becomes unavailable.
  Desktop Reading switches directly between Trash, Details and References.

## Automated evidence

`npm test`: 175 source suites / 870 tests, 43 mounted suites / 239 tests;
**1,109 tests passed**. Development and production bundled formula checks passed.

The 26 added mounted cases cover real modal behavior, all three Reading kinds,
editor handoff and focus, repeated relationship navigation, removal fallback,
Trash/context-panel switching, adjacent breakpoint continuity, uncertain placement
beneath navigation confirmation, and real unsubmitted search-draft remounts.
Existing responsive mutation-lock, Map, source navigation and exact-retry suites
remain part of the full run. Independent code review found no remaining blocker.

Clean TypeScript/Vite production build and desktop-only React Flow bundle gate passed.
CI results are recorded on the Draft PR for its exact head.

## Browser evidence

Chrome with the real local Worker/D1/R2 bindings, using dedicated Project
`project-f790244b-656f-4744-9b72-343a6b2e9613`.

- Details, source/relationship navigation and one inline editor were exercised.
  Bidirectional Tab wrapped between the first and last visible controls; Escape
  returned focus. Relationship navigation focused the exact referenced occurrence.
- At 860 → 859 and 860 → 360 CSS widths, the presentation switched between a
  non-modal desktop panel and one mobile modal without losing selection or query.
  Browser testing found and then confirmed the fix for unsubmitted query loss.
- At 360 × 600, Inspector stayed inside the viewport without horizontal overflow;
  the fraction and summation rendered. Related Reference discovery remained usable
  at 390 × 600. Mobile Trash close target measures 44 × 44 CSS pixels.
- At 1440 and 1024 widths, Reading and its floating Inspector did not overlap;
  the desktop document had no modal or inert background. The panel starts below
  the workspace header. Day and night surfaces and rendered math were inspected.
- Created and saved “C3 panel acceptance”, opened Details → Edit, and verified one
  focused editor. Stay retained the changed draft; Save Markdown and leave saved
  it and navigated to the exact Run source. Reopening the Project showed the saved
  text and fraction (occurrence `item-33a31089-8f0b-4b2a-948f-6976db6ab481`).
  Deleting through Details returned focus to Add; restoring from
  mobile Trash returned the same card, and closing Trash focused Project actions.

Responsive checks used a temporary same-origin iframe with a controlled CSS
viewport, not native phone emulation. The harness is excluded from source and
build artifacts. Native touch, soft-keyboard/visual-viewport behavior, safe-area
hardware and other browser engines remain device acceptance work. Full C4 review
across directory entry, empty/normal/large Projects and themes remains next.

## Extended pre-merge review — 2026-09-12

The additional review covers legacy inline confirmations stacked on mobile
panels, unmounting a lower editor while a leave confirmation remains open,
StrictMode route replacement, and restoration of existing inert/scroll state.

A pointer gesture crossing between the panel and its backdrop could dismiss the
panel because click dispatch uses the press/release targets' common ancestor.
The backdrop now requires the same primary pointer to start and finish on the
backdrop. Cancelled gestures and non-primary buttons cannot dismiss it; non-pointer
assistive activation and existing top-modal/pending guards remain supported.
See [Pointer Events click dispatch](https://www.w3.org/TR/pointerevents3/#event-dispatch).

The new `project-modal-boundaries.mount.test.tsx` records those integration and
specification-driven gesture sequences. Three gesture regressions failed against
the original implementation and passed after the fix. This is mounted event
evidence, not a new native pointer/browser session. The final integrated branch
also includes #168's loading/command and uncertain reconnect fixes, documented in
`PROJECT_UX_REPAIR_ACCEPTANCE.md`.
