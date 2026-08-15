from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


path = "worker/blob-lifecycle-review-fixes.test.ts"
replace_once(
    path,
    "        ).run(String(bindings[5]));",
    "        ).run(String(bindings[7]));",
)
replace_once(
    path,
    '''    expect(assetPut).toHaveBeenCalledTimes(1);
    expect(assetDelete).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      `SELECT asset_id FROM metrology_template_references
       WHERE template_version_id = 'template-metrology'`,
    ).get()).toEqual({ asset_id: "asset-winner" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM assets").get())
      .toEqual({ count: 1 });
''',
    '''    expect(assetPut).toHaveBeenCalledTimes(1);
    expect(assetDelete).not.toHaveBeenCalled();
    expect(database.prepare(
      `SELECT asset_id FROM metrology_template_references
       WHERE template_version_id = 'template-metrology'`,
    ).get()).toEqual({ asset_id: "asset-winner" });
    expect(database.prepare(`
      SELECT status, COUNT(*) AS count,
             SUM(CASE WHEN sha256 IS NULL THEN 1 ELSE 0 END) AS null_sha_count
      FROM assets
      GROUP BY status
      ORDER BY status
    `).all()).toEqual([
      { status: "failed", count: 1, null_sha_count: 1 },
      { status: "ready", count: 1, null_sha_count: 0 },
    ]);
''',
)
