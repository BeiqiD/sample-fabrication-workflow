export function templateDetailPath(templateId: string, templateKind: "process" | "metrology") {
  const encodedId = encodeURIComponent(templateId);
  return templateKind === "metrology"
    ? `/templates/metrology/${encodedId}`
    : `/templates/${encodedId}`;
}
