export function templateDetailPath(templateId: string, templateKind: "process" | "metrology") {
  const encodedId = encodeURIComponent(templateId);
  return templateKind === "metrology"
    ? `/templates/metrology/${encodedId}`
    : `/templates/${encodedId}`;
}

/** Retain only directory filters when an old import link moves into Settings. */
export function templateDirectorySearch(search: URLSearchParams) {
  const retained = new URLSearchParams();
  for (const key of ["q", "processPage", "metrologyPage"]) {
    const value = search.get(key);
    if (value) retained.set(key, value);
  }
  const query = retained.toString();
  return query ? `?${query}` : "";
}

export function workbookImportPath(search: URLSearchParams) {
  return `/settings/import-workbook${templateDirectorySearch(search)}`;
}
