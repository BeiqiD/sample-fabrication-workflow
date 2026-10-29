# FabuBlox Excel layouts and conversion

The importer supports two **export layouts**, identified from worksheet
structure. These are not Microsoft Excel application versions. The `Version`
value in an Overview sheet is a process revision, and OOXML `fileVersion` is
producer metadata; neither identifies a FabuBlox layout.

| Internal layout ID | Identifying content | Initial substrate | Diagram column |
| --- | --- | --- | --- |
| `classic-layer-stack` | Existing Step # / Step Name table with Parameters, Comments and Layer Stacks | Exactly one Step 0 named Substrate Stack | Explicit Layer Stacks header |
| `capability-flow` | Capability Type plus the newer parameter/Notes or leading-image layout, without classic Parameters/Comments/Layer Stacks headers | Exactly one explicit Substrate capability with blank or zero number | Explicit diagram header, or the supported blank A column before Step # in B |

Both input adapters produce the existing import manifest version 2. The initial
substrate retains the canonical Step 0 / Substrate Stack role expected by the
server. Its actual source name, supplemental substrate description and ordered
layer details remain in source cells; the substrate row is excluded from the
executable plan. An absent or ambiguous substrate is not guessed from another
process row or diagram. The original workbook remains the import provenance.

Process parameters, tool parameters, notes, recipe names and unknown source
columns are retained. Tool parameters are displayed with an explicit label,
separate from the process parameter text. M-numbered rows remain in the imported
plan; this compatibility adapter does not create independent Metrology template
entities or change process-run semantics.

## Updating an existing workflow across layouts

Layout compatibility primarily means importing a later recipe revision into the
same process-template family and updating an existing run with its existing
plan-update operation. The workbook does not have to be converted first.

Both adapters preserve step names. Excel row positions, step numbers, diagram
columns and export-layout IDs do not become step identities. The existing
alignment matches normalized names, unchanged definitions and repeated-name
occurrences, so a layout change alone must not replace executed run steps or
erase their actual parameters, comments, image records and status. Placeholder
names such as `-` remain unchanged rather than being silently renamed from a
capability field. Source capability/recipe metadata stays available in the
original manifest.

The imported template's substrate is a separate canonical initial snapshot,
never an extra executable row. A run's recorded initial snapshot remains
immutable when its future plan is updated. New template versions and plan
updates remain separate explicit operations; existing workflows are not
automatically rewritten by importing a file. Actual step renames or ambiguous
repeated definitions remain a plan-alignment review concern, independent of
Excel layout compatibility.

## Converting a workbook

The conversion action belongs to Settings → Workbook import. It reads the
selected file locally, parses it through the same input adapter, then writes the
chosen target layout. It neither imports a template nor modifies the original
file. The converter uses this pipeline rather than a separate converter for
every pair of layouts:

```text
source layout → stable import representation → target layout
```

The output preserves parsed process order, sections, substrate details, Unicode
text, M-numbered rows, extension values and process diagram bytes. Pictures get
new explicit OOXML relationships and anchors on their corresponding output rows.
Unknown columns remain extension columns. If a source value differs from its
normalized target cell, it is retained under a `Source column: …` header; name
collisions get distinct suffixes. Layer Stacks extensions are prefixed where
necessary so they cannot accidentally select the classic adapter in a capability
workbook. Split tool parameters survive conversion through the classic combined
Parameters field without being duplicated when converted back.

Conversion is a content-layout conversion, not a visual reproduction or a
certification that an external FabuBlox service accepts the generated file.
Original styling, arbitrary extra sheets, Overview logos and formulas are not
reproduced; only cached formula values already read by the importer are carried
over. Formula-like text is emitted as literal Excel text. Every conversion
returns this scope warning and includes it in a Conversion info sheet. Original
files should be retained when their full Excel formatting or auxiliary content
is needed.

The converter refuses missing or ambiguous substrates, unassigned diagrams,
initial diagrams outside the declared selection, unsupported image formats and
content that exceeds Excel cell limits. It does not truncate text, silently
discard diagrams or invent an initial state. WebP bytes can be retained, with an
additional warning that older Excel applications may not display them. Binary
`.xls` is outside this `.xlsx` compatibility work.

## Supporting a future layout

1. Add a small synthetic workbook that reproduces its structural differences;
   do not commit private process workbooks as fixtures.
2. Add or adjust the descriptor in
   [`fabublox-formats.ts`](../src/lib/fabublox-formats.ts): column aliases,
   structural matching, explicit substrate role, diagram-column rules and
   supplemental sheet rules. Keep specific signatures ahead of the classic
   fallback. Parsing should still produce the same canonical manifest.
3. If conversion to the layout is supported, add its row writer to
   `TARGET_CELL_WRITERS` in
   [`fabublox-convert.ts`](../src/lib/fabublox-convert.ts). The typed record
   requires an explicit implementation for every registered layout; there is
   no implicit writer fallback. Output headers and diagram columns come from
   the shared registry.
4. Run the existing classic import tests, new-layout tests, both conversion
   directions and round trips. Check substrate selection, ordered layers,
   split parameters, M rows, sections, unknown/case-distinct columns, XML text,
   exact image bytes, ambiguous definitions and visible conversion limits.

The Settings format selector reads the same registry. Neither a new layout nor
an Overview process revision requires changing the stored import schema or the
meaning of existing immutable template versions.
