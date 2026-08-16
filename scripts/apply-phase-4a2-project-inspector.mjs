import { readFileSync, writeFileSync } from "node:fs";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing ${label} patch anchor`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Ambiguous ${label} patch anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const pagePath = "src/pages/ProjectPage.tsx";
let page = readFileSync(pagePath, "utf8");
page = replaceExactlyOnce(
  page,
  'import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";\n',
  'import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";\nimport { ProjectInspectorDetails } from "../components/project/ProjectInspectorDetails";\n',
  "Project Inspector import",
);
page = replaceExactlyOnce(
  page,
`          <span className="meta-badge">{selected.kind}</span>
          <h2>{selected.title}</h2>
          {selected.subtitle && <p className="card-meta">{selected.subtitle}</p>}
          {selected.excerpt && <p className="project-inspector-excerpt">{selected.excerpt}</p>}
          <dl>
            <dt>Occurrence</dt><dd>{selected.itemId}</dd>
            <dt>Position</dt><dd>{Math.round(selected.geometry.x)}, {Math.round(selected.geometry.y)}</dd>
            <dt>Size</dt><dd>{Math.round(selected.geometry.width)} × {Math.round(selected.geometry.height)}</dd>
          </dl>
`,
  '          <ProjectInspectorDetails snapshot={snapshot} descriptor={selected} />\n',
  "legacy Inspector summary",
);
page = replaceExactlyOnce(
  page,
`          {selected.openReferenceUrl && <Link className="button wide" to={selected.openReferenceUrl}>Open reference</Link>}
          {selected.fileUrl && <a className="button wide" href={selected.fileUrl}>Open attachment</a>}
`,
  "",
  "duplicate Inspector actions",
);
writeFileSync(pagePath, page);

const roadmapPath = "docs/PRODUCT_ROADMAP.md";
let roadmap = readFileSync(roadmapPath, "utf8");
roadmap = replaceExactlyOnce(
  roadmap,
`and recovery in PR #141, and Phase 3D rich content/export plus the shared
Project/Comment renderer in PRs #143/#144
`,
`and recovery in PR #141, Phase 3D rich content/export plus the shared
Project/Comment renderer in PRs #143/#144, and Phase 4A1 canonical Project
occurrence focus in PR #145
`,
  "roadmap review history",
);
roadmap = replaceExactlyOnce(
  roadmap,
`surfaces in PR #144. Phase 4A Inspector and navigation completeness is now the
active product target. Storage, lifecycle, Reference, and rich-content foundations
`,
`surfaces in PR #144. Phase 4A1 canonical Project occurrence focus is complete in
PR #145. Phase 4A2 Inspector hierarchy, provenance, and type-specific detail is
now the active bounded slice. Storage, lifecycle, Reference, and rich-content foundations
`,
  "roadmap current position",
);
roadmap = replaceExactlyOnce(
  roadmap,
`**Status:** active; begin with Phase 4A1 canonical Project occurrence focus links.
`,
`**Status:** active; Phase 4A1 is complete in PR #145 and Phase 4A2 hierarchy/provenance is active.
`,
  "Phase 4A status",
);
roadmap = replaceExactlyOnce(
  roadmap,
`1. Complete **Phase 4A1** canonical Project occurrence focus links and exact
   Map/Reading navigation.
2. Complete the remaining **Phase 4A** Inspector hierarchy/provenance and
   authoritative child-reference insertion slices.
3. Complete **Phase 4B** the selected v1 Canvas productivity operations.
4. Complete **Phase 4C** representative-scale performance work and make explicit
   include/defer decisions for remaining optional interaction candidates.
5. Declare the **v1 feature freeze** once the interaction-shaping feature set is
   stable.
6. Run **Phase 5 frontend refinement** as a dedicated whole-product pass.
7. Run **Phase 6 release hardening** and real-use/operational rehearsal.
`,
`1. Complete **Phase 4A2** Inspector hierarchy, provenance, type-specific details,
   and exact source navigation.
2. Complete **Phase 4A3** authoritative child-reference insertion through the
   existing Reference and Project placement path.
3. Complete **Phase 4B** the selected v1 Canvas productivity operations.
4. Complete **Phase 4C** representative-scale performance work and make explicit
   include/defer decisions for remaining optional interaction candidates.
5. Declare the **v1 feature freeze** once the interaction-shaping feature set is
   stable.
6. Run **Phase 5 frontend refinement** as a dedicated whole-product pass.
7. Run **Phase 6 release hardening** and real-use/operational rehearsal.
`,
  "immediate PR order",
);
writeFileSync(roadmapPath, roadmap);
