export const settingsDestinations = {
  research: { to: "/settings/data", label: "Research packages & reports", description: "Export selected Samples or Projects as a native package or offline report, import a native package, and review saved package work." },
  archive: { to: "/export", label: "Content archive", description: "Build a ZIP in this browser. Leaving its page cancels an active export and releases any prepared download." },
  workbook: { to: "/settings/import-workbook", label: "Workbook import", description: "Bring an existing FabuBlox process into Templates, then work with its steps and runs in the web workspace." },
  storage: { to: "/settings/storage", label: "Storage overview", description: "Current upload destinations and registered profiles." },
  connections: { to: "/settings/storage/configuration", label: "Connections", description: "Add, test and activate storage candidates." },
  migrations: { to: "/settings/storage/migrations", label: "File migrations", description: "Review migration plans, execution and saved jobs." },
  recovery: { to: "/settings/data/system", label: "Backup and recovery", description: "Administrator-managed backup jobs and isolated system recovery." },
  shadow: { to: "/maintenance/file-shadow", label: "File shadow pilot", description: "" },
  evidence: { to: "/maintenance/file-evidence", label: "File evidence", description: "Inspect recorded attachment history and unresolved evidence." },
  authority: { to: "/maintenance/file-authority", label: "File authority", description: "" },
} as const;

export const settingsGroups = [
  { id: "data", label: "Data and export", destinations: [settingsDestinations.research, settingsDestinations.archive, settingsDestinations.workbook] },
  { id: "storage", label: "Storage", destinations: [settingsDestinations.storage, settingsDestinations.connections, settingsDestinations.migrations] },
  { id: "system", label: "System and maintenance", destinations: [settingsDestinations.recovery] },
] as const;

export const advancedSettingsDestinations = [settingsDestinations.evidence, settingsDestinations.shadow, settingsDestinations.authority] as const;
