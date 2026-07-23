# FabuBlox browser import

The importer is format-aware for FabuBlox OOXML workbooks. It is not presented as a universal Excel importer.

## Parsing contract

1. JSZip opens the OPC package; workbooks larger than 50 MB and worksheets with more than 100,000 materialized cells are rejected before import.
2. `workbook.xml`, worksheet XML, inline strings, and `sharedStrings.xml` provide sheet names and resolved cell values without a general-purpose spreadsheet runtime.
3. Normalized labels locate the known FabuBlox headers.
4. Workbook relationships resolve the selected worksheet part, whose relationships resolve its drawing part.
5. Drawing relationships resolve each embedded image relationship to its media part.
6. `oneCellAnchor` and `twoCellAnchor` coordinates map drawings to source rows.
7. A layer-stack image anchored before the first process step is recognized as the initial substrate structure.
8. Other images outside the detected layer-stack column or without a matching step remain unassigned and produce visible warnings.

Media filenames are never used to infer step order. Resolved shared-string values are used instead of raw shared-string indices.

## Preview and confirmation

The preview shows the detected sheet, process-template relationship, initial substrate structure, structured step fields, layer-stack thumbnails, unassigned images, and warnings. Nothing is uploaded before confirmation.

Confirmation sends one multipart request containing:

- the original workbook;
- a schema-versioned normalized manifest;
- compressed extracted images keyed by local image ID.

The Worker creates a pending import, stores workbook/manifest/images in R2, writes an immutable process-template version with its initial-state hash and normalized steps/assets to D1, and only then marks the import ready. Pending and failed imports are hidden from process-run choices.

## Test strategy

- Generated fixtures verify inline/shared/rich strings, header detection, relationship-based media resolution, `oneCellAnchor`/`twoCellAnchor`, deliberately reordered media filenames, and unassigned-image warnings.
- Real workbooks remain private local fixtures and are never committed to the public repository.
