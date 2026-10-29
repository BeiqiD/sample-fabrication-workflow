# FabuBlox browser import

The importer is format-aware for FabuBlox OOXML workbooks. It is not presented as a universal Excel importer.

## Parsing contract

1. JSZip opens the OPC package; workbooks larger than 50 MB and worksheets with more than 100,000 materialized cells are rejected before import.
2. `workbook.xml`, worksheet XML, inline strings, and `sharedStrings.xml` provide sheet names and resolved cell values without a general-purpose spreadsheet runtime.
3. Normalized labels and the layout registry identify classic Layer Stacks or capability-flow headers. Layout identities are separate from the manifest schema and the workbook's process revision.
4. Workbook relationships resolve the selected worksheet part, whose relationships resolve its drawing part.
5. Drawing relationships resolve each embedded image relationship to its media part.
6. `oneCellAnchor` and `twoCellAnchor` coordinates map drawings to source rows.
7. Only an explicit initial role supplies the initial substrate: classic Step 0 named Substrate Stack, or an unnumbered/zero capability-flow Substrate row. Its own diagram-column images become the initial structure. Missing/ambiguous definitions never borrow the first process diagram. A matching auxiliary Substrate sheet can enrich the explicitly declared row.
8. Images without a matching row remain unassigned. Images outside the detected diagram column produce visible warnings; they never substitute for the initial diagram.

Media filenames are never used to infer step order. Resolved shared-string values are used instead of raw shared-string indices.

## Preview and confirmation

The preview shows the detected sheet, process-template relationship, initial substrate structure, structured step fields, layer-stack thumbnails, unassigned images, and warnings. Nothing is uploaded before confirmation.

Capability-flow process/tool parameters and Notes are retained, as are recipe,
capability and unknown source columns. Metrology-labelled rows remain in their
ordered imported plan with an explicit warning; this importer does not create
independent Metrology templates or change execution semantics.

Confirmation sends one multipart request containing:

- the original workbook;
- a schema-versioned normalized manifest;
- compressed extracted images keyed by local image ID.

The Worker creates a pending import, stores workbook/manifest/images in R2, writes an immutable process-template version with its initial-state hash and normalized steps/assets to D1, and only then marks the import ready. Pending and failed imports are hidden from process-run choices.

The browser retires the corresponding completed-request checkpoint after its
result successfully opens, so returning to Settings does not restore an old
success notice. Unknown results and failed result navigation remain recoverable.

## Workbook layout conversion

The Settings import preview offers an optional, collapsed layout conversion
tool. Conversion is browser-local and downloads a separate content-compatible
workbook; it does not submit an import or alter the original file. Supported
layouts, preserved fields, conversion limits and the extension points for future
formats are documented in [Workbook layouts and conversion](FABUBLOX_WORKBOOK_FORMATS.md).

## Test strategy

- Generated fixtures verify inline/shared/rich strings, header detection, relationship-based media resolution, `oneCellAnchor`/`twoCellAnchor`, deliberately reordered media filenames, and unassigned-image warnings.
- Real workbooks remain private local fixtures and are never committed to the public repository.
