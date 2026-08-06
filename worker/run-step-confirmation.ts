export function returnedEveryConfirmationTarget(rows: unknown, stepIds: string[]) {
  if (!Array.isArray(rows) || rows.length !== stepIds.length) return false;
  const returnedIds = new Set(rows.map((row) => (
    row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
      ? (row as { id: string }).id
      : null
  )));
  return returnedIds.size === stepIds.length && stepIds.every((id) => returnedIds.has(id));
}

export function confirmationEventBody(stepNames: string[]) {
  const names = stepNames.map((name) => name.trim()).filter(Boolean);
  return names.length
    ? `Confirmed as done: ${names.join("; ")}`
    : "Confirmed step as done";
}
