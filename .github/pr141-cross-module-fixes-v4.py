from pathlib import Path

runner = Path(".github/pr141-cross-module-fixes-v3.py")
exec(compile(runner.read_text(), str(runner), "exec"), {"__name__": "__main__"})

path = Path("worker/fabublox-import-recovery.ts")
text = path.read_text()
old = '''  if (!Number(results[0].meta.changes ?? 0)) return emptyCleanupResult();
  const relationshipResultIndexes = [2, 3, 4];
  return {
    importsFailed: Number(results[0].meta.changes ?? 0),
    relationshipsRemoved: relationshipResultIndexes.reduce(
      (total, index) => total + Number(results[index].meta.changes ?? 0),
      0,
    ),
    templateStepsRemoved: Number(results[5].meta.changes ?? 0),
    templatesQuarantined: Number(results[6].meta.changes ?? 0),
    assetsReleased:
      Number(results[22].meta.changes ?? 0)
      + Number(results[25].meta.changes ?? 0)
      + Number(results[27].meta.changes ?? 0),
    objectsQueued: Number(results[29].meta.changes ?? 0),
  };
'''
new = '''  const resultIndexes = {
    claim: 0,
    removedRelationships: [2, 3, 4],
    removedTemplateSteps: 5,
    quarantinedTemplate: 6,
    releasedAssets: [23, 26, 28],
    queuedObjects: 30,
  } as const;
  if (!Number(results[resultIndexes.claim].meta.changes ?? 0)) {
    return emptyCleanupResult();
  }
  return {
    importsFailed: Number(
      results[resultIndexes.claim].meta.changes ?? 0,
    ),
    relationshipsRemoved: resultIndexes.removedRelationships.reduce(
      (total, index) => total + Number(results[index].meta.changes ?? 0),
      0,
    ),
    templateStepsRemoved: Number(
      results[resultIndexes.removedTemplateSteps].meta.changes ?? 0,
    ),
    templatesQuarantined: Number(
      results[resultIndexes.quarantinedTemplate].meta.changes ?? 0,
    ),
    assetsReleased: resultIndexes.releasedAssets.reduce(
      (total, index) => total + Number(results[index].meta.changes ?? 0),
      0,
    ),
    objectsQueued: Number(
      results[resultIndexes.queuedObjects].meta.changes ?? 0,
    ),
  };
'''
if text.count(old) != 1:
    raise SystemExit("Could not update recovery result indexes")
path.write_text(text.replace(old, new, 1))
