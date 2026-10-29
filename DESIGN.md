# Research interface design contract

Approved by the user on 2026-10-29 after the first-stage TasteSkill / Impeccable
review. Product truth and the supported sample/run/template model remain in
README.md. This contract owns presentation; API, permissions, identity, recovery,
dirty-edit and save behavior remain owned by their existing modules.

The interface serves everyday laboratory work. Processing, Samples, Projects and
Templates support work in the browser. Settings owns import/export, storage and
administration. Operate mode governs controls and data; Project Reading has its
own document rhythm. The shared signature is a compact identity/context summary
followed by the work itself, with complete secondary information available through
clear, editing-safe disclosures.

- Neutral gray-white surfaces in light mode, graphite surfaces in dark mode;
  one low-saturation blue interaction accent. Workflow colors still communicate
  their actual states, and ordinary creation/edit/navigation stays neutral.
- `palette.css` exclusively owns interface color tokens. `styles.css` owns
  typography/density and workflow-state tokens. Existing route styles own their
  composition and responsive projections.
- System sans-serif typography; tabular figures in counts and comparisons.
  Page titles are 32px desktop / 28px mobile, sections 18px, body/ordinary field
  values 14px and labels/metadata 12px. Reading and Dense cells retain their roles.
- Daily actions use 32px desktop / 36px mobile controls and 16px icons; ordinary
  forms use approximately 40px controls. These are roles, not a global size reset.
- Directory rows and dividers carry lists. Containers identify editing or distinct
  tasks. Title, action and search patterns share small presentation primitives;
  pages retain query, paging, data and action state.
- Sample identity and status stay immediately visible. Current structure and
  notes precede full metadata; editing cannot be accidentally hidden by collapsing
  details. Sample state and Run state remain separately identified.
- Processing context is compact and full guidance stays available. Planned and
  actual execution, per-sample columns and batch scope remain explicit.
- Templates expose Process/Metrology navigation, latest versions first and
  expandable history. Settings names agree with destinations; advanced tools
  disclose progressively, while paused/error states remain visible.
- Initial-substrate and source-provenance details stay secondary and default
  collapsed in import review. Routine import notes stay collapsed; missing or
  ambiguous data and required structure-handoff confirmations remain visible.
- Native links/buttons, complete icon names, keyboard focus, main-content bypass,
  reduced-motion feedback and sufficient contrast are required. Decorative
  eyebrow labels do not precede headings; meaningful record/version context stays
  visible as metadata.

No new UI framework, icon package, animation dependency or business-state model
is required. Validate the rendered implementation at desktop, tablet and phone
sizes in both themes, including realistic long/empty/error content, the 720px and
859px projection boundaries, Sample Edit/Cancel and Project dirty-edit behavior.
Actual evidence and remaining limits belong in the dated implementation report;
this contract is not a claim that those checks have already passed.
