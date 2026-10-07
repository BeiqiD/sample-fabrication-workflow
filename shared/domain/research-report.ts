/** Presentation consumes only this captured domain projection. Public package
 * contracts validate the complete envelope before passing it to the renderer;
 * rendering does not own wire schemas, acceptance, or publication authority. */
export interface ResearchReportRecord {
  kind: string; sourceId: string; data: Record<string, unknown>;
}
export interface ResearchReportSnapshot {
  packageId: string; createdAt: string; completeness: "complete" | "partial";
  roots: readonly { kind: "sample" | "project"; id: string }[];
  records: readonly ResearchReportRecord[];
  files: readonly {
    packageFileId: string; path: string; purpose: string; byteSize: number; sha256: string; mediaType: string | null;
  }[];
  dependencies: readonly {
    owner: { kind: string }; field: string; target: { kind: string };
    resolution: "included" | "unresolved" | "deleted" | "excluded";
  }[];
}

function html(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function markdown(value: unknown): string { return String(value ?? "").replaceAll("\\", "\\\\").replace(/([`*_{}\[\]<>#|])/g, "\\$1"); }
function label(record: ResearchReportRecord): string {
  return String(record.data.title ?? record.data.code ?? record.data.name ?? record.data.display_name ?? record.data.original_name ?? record.sourceId);
}
function anchor(record: ResearchReportRecord): string { return `record-${encodeURIComponent(record.kind)}-${encodeURIComponent(record.sourceId)}`; }
function textBody(record: ResearchReportRecord): string {
  return String(record.data.body ?? record.data.markdown_source ?? record.data.notes ?? record.data.description ?? record.data.note ?? record.data.attachment_caption ?? "");
}

/** A static reading projection of captured records. User Markdown is displayed
 * as text; no user HTML, remote media, provider URL, script, or live API is used. */
export function renderResearchPackageReport(snapshot: ResearchReportSnapshot): { html: string; markdown: string } {
  const records = snapshot.records, byKey = new Map(records.map(record => [`${record.kind}:${record.sourceId}`, record]));
  const files = new Map(snapshot.files.map(file => [file.packageFileId, file]));
  const roots = snapshot.roots.map(root => byKey.get(`${root.kind}:${root.id}`)).filter((record): record is ResearchReportRecord => Boolean(record));
  const title = roots.map(label).join(" · ") || "Research report";
  const document: string[] = [], plain: string[] = [`# ${markdown(title)}`, "", `Captured: ${markdown(snapshot.createdAt)}`, "",
    `Package: ${markdown(snapshot.packageId)}`, "", `Completeness: ${snapshot.completeness}`, "",
    "This report is a captured reading view. Imported provenance and preview claims do not establish destination verification.", ""];
  document.push(`<header><h1>${html(title)}</h1><p>Captured ${html(snapshot.createdAt)}</p><p>Completeness: ${html(snapshot.completeness)}</p>
    <p>This report is a captured reading view. Imported provenance and preview claims do not establish destination verification.</p></header>`);
  document.push(`<nav aria-label="Selected roots"><ul>${roots.map(record => `<li><a href="#${html(anchor(record))}">${html(label(record))}</a></li>`).join("")}</ul></nav>`);
  const fileLinks = (record: ResearchReportRecord): { markup: string; lines: string[] } => {
    const output: string[] = [], lines: string[] = [];
    for (const [field, value] of Object.entries(record.data)) if (field === "packageFileId" || /PackageFileId$/.test(field)) {
      if (value === null) {
        if (["fileAlias", "executionImage", "metrologyReference", "projectAttachment", "stateAsset"].includes(record.kind)
          || record.kind === "commentItem" && record.data.kind !== "link") {
          output.push(`<p>${html(field)}: File not included</p>`); lines.push(`${field}: File not included`);
        }
        continue;
      }
      const file = files.get(String(value));
      if (!file) { output.push(`<p>${html(field)}: File not included</p>`); lines.push(`${field}: File not included`); continue; }
      const path = `../${file.path}`;
      output.push(`<p><a href="${html(path)}">${html(field)} · ${html(file.purpose)} · ${file.byteSize} bytes</a></p>`);
      if (file.mediaType && /^image\/(?:png|jpeg|gif|webp|avif)$/.test(file.mediaType)) output.push(`<img src="${html(path)}" alt="${html(label(record))}" loading="lazy">`);
      lines.push(`[${markdown(field)} · ${file.purpose} · ${file.byteSize} bytes](${path})`, `SHA-256: ${file.sha256}`);
    }
    return { markup: output.join(""), lines };
  };
  const section = (record: ResearchReportRecord, level = 2) => {
    const body = textBody(record), attachments = fileLinks(record);
    const status = record.data.deleted_at ? "Deleted" : record.data.superseded_by_occurrence_id ? "Superseded" : String(record.data.status ?? record.data.plan_status ?? "Captured");
    const fields = Object.entries(record.data).filter(([field]) => !["body", "markdown_source", "notes", "description", "note", "attachment_caption"].includes(field));
    document.push(`<section id="${html(anchor(record))}"><h${level}>${html(label(record))}</h${level}><p>${html(record.kind)} · ${html(status)}</p>
      ${body ? `<pre class="prose">${html(body)}</pre>` : ""}${attachments.markup}<details><summary>Captured context and history</summary><dl>
      ${fields.map(([field, value]) => `<dt>${html(field)}</dt><dd>${html(typeof value === "object" ? JSON.stringify(value) : value)}</dd>`).join("")}</dl></details></section>`);
    plain.push(`${"#".repeat(level)} ${markdown(label(record))}`, "", `${record.kind} · ${markdown(status)}`, "", markdown(body), "", ...attachments.lines, "");
    plain.push(...fields.map(([field, value]) => `- ${markdown(field)}: ${markdown(typeof value === "object" ? JSON.stringify(value) : value)}`), "");
  };
  const emitted = new Set<string>();
  const emit = (record: ResearchReportRecord, level = 2) => {
    const key = `${record.kind}:${record.sourceId}`;
    if (emitted.has(key)) return;
    emitted.add(key); section(record, level);
    if (record.kind === "commentOccurrence" && record.data.submission_id) {
      const comment = byKey.get(`comment:${record.data.submission_id}`), step = byKey.get(`runStep:${record.data.run_step_id}`);
      if (comment && step) {
        document.push(`<p>Comment context: <a href="#${html(anchor(step))}">${html(label(step))}</a> → <a href="#${html(anchor(comment))}">canonical Comment</a></p>`);
        plain.push(`Comment context: [${markdown(label(step))}](#${anchor(step)}) → [canonical Comment](#${anchor(comment)})`, "");
      }
    }
  };
  for (const root of roots) {
    emit(root);
    if (root.kind === "sample") {
      const runs = records.filter(record => record.kind === "run" && record.data.sample_id === root.sourceId).sort((left, right) => Number(left.data.sequence_no) - Number(right.data.sequence_no));
      for (const run of runs) {
        emit(run, 3);
        const steps = records.filter(record => record.kind === "runStep" && record.data.run_id === run.sourceId).sort((left, right) => Number(left.data.position) - Number(right.data.position));
        for (const step of steps) {
          emit(step, 4);
          for (const occurrence of records.filter(record => record.kind === "commentOccurrence" && record.data.run_step_id === step.sourceId)) {
            const comment = occurrence.data.submission_id ? byKey.get(`comment:${occurrence.data.submission_id}`) : null;
            emit(occurrence, 4);
            if (comment) emit(comment, 4);
          }
          for (const image of records.filter(record => record.kind === "executionImage" && record.data.run_step_id === step.sourceId)) emit(image, 4);
        }
      }
      for (const comment of records.filter(record => record.kind === "comment" && record.data.sample_id === root.sourceId)) emit(comment, 3);
      for (const event of records.filter(record => record.kind === "event" && record.data.sample_id === root.sourceId).sort((a, b) => String(a.data.created_at).localeCompare(String(b.data.created_at)))) emit(event, 3);
    }
    if (root.kind === "project") {
      const items = records.filter(record => record.kind === "projectItem" && record.data.project_id === root.sourceId).sort((a, b) => Number(a.data.created_sequence) - Number(b.data.created_sequence));
      document.push(`<ol class="project-items">${items.map(item => `<li>${html(item.data.item_type)} · ${html(item.sourceId)}</li>`).join("")}</ol>`);
      plain.push("Project item order:", "", ...items.map((item, index) => `${index + 1}. ${item.data.item_type} · ${markdown(item.sourceId)}`), "");
      for (const item of items) {
        const content = item.data.project_content_id ? byKey.get(`projectContent:${item.data.project_content_id}`) : null;
        if (content) { emit(content, 3); const attachment = byKey.get(`projectAttachment:${content.sourceId}`); if (attachment) emit(attachment, 3); }
        const reference = item.data.reference_target_id ? byKey.get(`reference:${item.data.reference_target_id}`) : null;
        if (reference) {
          emit(reference, 3);
          const target = reference.data.target as { kind: string; sourceId: string };
          document.push(`<p>Reference: ${html(target.kind)} · ${html(target.sourceId)} · ${html(reference.data.resolution)}</p>`);
          plain.push(`Reference: ${markdown(target.kind)} · ${markdown(target.sourceId)} · ${markdown(reference.data.resolution)}`, "");
          const targetRecord = byKey.get(`${target.kind}:${target.sourceId}`); if (targetRecord) emit(targetRecord, 3);
        }
      }
      const placements = records.filter(record => record.kind === "projectPlacement" && items.some(item => item.sourceId === record.data.project_item_id));
      if (placements.length) {
        document.push(`<details><summary>Captured map coordinates</summary><table><thead><tr><th>Item</th><th>x</th><th>y</th><th>Width</th><th>Height</th><th>Layer</th></tr></thead><tbody>${placements.map(record => `<tr>${[record.data.project_item_id, record.data.x, record.data.y, record.data.width, record.data.height, record.data.z_index].map(value => `<td>${html(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`);
        plain.push("| Item | x | y | Width | Height | Layer |", "| --- | --- | --- | --- | --- | --- |", ...placements.map(record => `| ${[record.data.project_item_id, record.data.x, record.data.y, record.data.width, record.data.height, record.data.z_index].map(markdown).join(" | ")} |`), "");
      }
      const edges = records.filter(record => record.kind === "projectEdge" && record.data.project_id === root.sourceId);
      if (edges.length) {
        document.push(`<table><caption>Captured Project graph</caption><thead><tr><th>Source item</th><th>Target item</th><th>Label</th><th>Handles</th><th>Markers</th><th>State</th></tr></thead><tbody>
          ${edges.map(edge => `<tr>${[edge.data.source_item_id, edge.data.target_item_id, edge.data.label, `${edge.data.source_handle} → ${edge.data.target_handle}`,
            `${edge.data.marker_start} → ${edge.data.marker_end}`, edge.data.deleted_at ? "Deleted" : "Captured"].map(value => `<td>${html(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        plain.push("Captured Project graph:", "", ...edges.map(edge => `- ${markdown(edge.data.source_item_id)} → ${markdown(edge.data.target_item_id)} · ${markdown(edge.data.label)} · ${edge.data.source_handle}/${edge.data.target_handle} · ${edge.data.marker_start}/${edge.data.marker_end}${edge.data.deleted_at ? " · Deleted" : ""}`), "");
      }
    }
  }
  for (const record of records.filter(record => ["commentItem", "stateVerification", "recipeRevision", "metrologyReference"].includes(record.kind))) emit(record, 3);
  // A Project may reference a run, Sample, occurrence, or immutable revision.
  // Every captured dependency remains readable even when it is not a root.
  for (const record of records) emit(record, 3);
  if (snapshot.dependencies.length) {
    document.push(`<section><h2>Dependency outcomes</h2><ul>${snapshot.dependencies.map(dependency => `<li>${html(dependency.owner.kind)} · ${html(dependency.field)} → ${html(dependency.target.kind)} · ${html(dependency.resolution)}</li>`).join("")}</ul></section>`);
    plain.push("## Dependency outcomes", "", ...snapshot.dependencies.map(dependency => `- ${dependency.owner.kind} · ${markdown(dependency.field)} → ${dependency.target.kind} · ${dependency.resolution}`), "");
  }
  const output = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${html(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;color:#17202a}section{border-top:1px solid #ddd;margin:1.5rem 0;padding-top:1rem}.prose{white-space:pre-wrap;font:inherit}img{max-width:100%;max-height:32rem}table{border-collapse:collapse}th,td{padding:.3rem .6rem;border:1px solid #ddd}a{overflow-wrap:anywhere}</style></head><body>${document.join("\n")}</body></html>`;
  return { html: output, markdown: plain.join("\n") };
}
