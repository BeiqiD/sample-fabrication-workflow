import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFileConsumerSnapshot } from "./file-consumer-preflight-cli";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(version = 7) {
  const directory = await mkdtemp(join(tmpdir(), "consumer-preflight-cli-"));
  directories.push(directory);
  const databasePath = join(directory, "snapshot.sqlite"), outputPath = join(directory, "report.json");
  const db = new DatabaseSync(databasePath);
  try {
    const source = new URL("../../migrations/", import.meta.url);
    for (const name of readdirSync(source).filter((name) => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= version).sort()) {
      db.exec(readFileSync(new URL(name, source), "utf8"));
    }
    db.exec(`INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('preflight-sample', 'PREFLIGHT-CLI', 'PRIVATE_TITLE', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
      INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, created_at)
      VALUES ('preflight-event', 'preflight-sample', 'image', 'PRIVATE_BODY_SENTINEL', 'unregistered/image',
        '{"thumbnailKey":"unregistered/thumbnail","privateCredential":"PRIVATE_SECRET_SENTINEL"}', '2026-09-25T00:00:00.000Z');`);
  } finally { db.close(); }
  return { directory, databasePath, outputPath };
}

describe("local File consumer preflight", () => {
  it("inspects non-empty current state without changing SQLite bytes or disclosing content", async () => {
    const f = await fixture();
    const before = await readFile(f.databasePath);
    const result = await inspectFileConsumerSnapshot(f);
    const encoded = await readFile(f.outputPath, "utf8");
    expect(result).toMatchObject({ executable: false, bytesVerified: false, outputPath: f.outputPath });
    expect(result.consumers).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(encoded)).toMatchObject({ executable: false, bytesVerified: false });
    expect(encoded).toContain("unregistered/image");
    expect(encoded).not.toContain("PRIVATE_BODY_SENTINEL");
    expect(encoded).not.toContain("PRIVATE_SECRET_SENTINEL");
    expect(encoded).not.toContain("PRIVATE_TITLE");
    expect(await readFile(f.databasePath)).toEqual(before);
    expect((await readdir(f.directory)).sort()).toEqual(["report.json", "snapshot.sqlite"]);
    const next = join(f.directory, "repeat.json");
    await inspectFileConsumerSnapshot({ ...f, outputPath: next });
    expect(await readFile(next, "utf8")).toBe(encoded);
  });

  it("keeps pages explicit and resumes using the exact typed cursor", async () => {
    const f = await fixture();
    const first = await inspectFileConsumerSnapshot({ ...f, limit: 1 });
    expect(first.consumers).toBe(1);
    expect(first.nextCursor).not.toBeNull();
    const secondPath = join(f.directory, "page2.json");
    const second = await inspectFileConsumerSnapshot({ ...f, outputPath: secondPath, limit: 1, after: first.nextCursor! });
    expect(second.consumers).toBe(1);
    const records1 = JSON.parse(await readFile(f.outputPath, "utf8")).records;
    const records2 = JSON.parse(await readFile(secondPath, "utf8")).records;
    expect(records1).not.toEqual(records2);
  });

  it("never overwrites prior reports or uses the database or a sidecar as output", async () => {
    const f = await fixture();
    await writeFile(f.outputPath, "previous result");
    await expect(inspectFileConsumerSnapshot(f)).rejects.toThrow("Output already exists");
    expect(await readFile(f.outputPath, "utf8")).toBe("previous result");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      await expect(inspectFileConsumerSnapshot({ ...f, outputPath: f.databasePath + suffix })).rejects.toThrow("different paths");
    }
    expect((await readdir(f.directory)).sort()).toEqual(["report.json", "snapshot.sqlite"]);
  });

  it("rejects old schema, invalid options and non-SQLite input without publishing a report", async () => {
    const f = await fixture(6);
    await expect(inspectFileConsumerSnapshot(f)).rejects.toThrow();
    expect(await readdir(f.directory)).toEqual(["snapshot.sqlite"]);
    const current = await fixture();
    for (const limit of [0, -1, 1.5, 21, Number.NaN]) {
      await expect(inspectFileConsumerSnapshot({ ...current, limit })).rejects.toThrow();
    }
    const textPath = join(current.directory, "text.sqlite");
    await writeFile(textPath, "not a database");
    await expect(inspectFileConsumerSnapshot({ ...current, databasePath: textPath })).rejects.toThrow("SQLite database");
    await expect(inspectFileConsumerSnapshot({ ...current, databasePath: current.directory })).rejects.toThrow("regular SQLite file");
  });

  it("rejects a database sidecar output through a symlinked directory alias", async () => {
    const f = await fixture();
    const alias = join(f.directory, "alias");
    await symlink(f.directory, alias, "dir");
    const before = await readFile(f.databasePath);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      await expect(inspectFileConsumerSnapshot({ ...f, outputPath: join(alias, `snapshot.sqlite${suffix}`) })).rejects.toThrow("different paths");
    }
    expect(await readFile(f.databasePath)).toEqual(before);
    expect((await readdir(f.directory)).sort()).toEqual(["alias", "snapshot.sqlite"]);
  });

  it("refuses WAL and journal inputs instead of ignoring committed sidecar state", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.databasePath);
    try { db.exec("PRAGMA journal_mode=WAL"); } finally { db.close(); }
    const before = await readFile(f.databasePath);
    await expect(inspectFileConsumerSnapshot(f)).rejects.toThrow("WAL databases");
    expect(await readFile(f.databasePath)).toEqual(before);
    const rollback = await fixture();
    await writeFile(rollback.databasePath + "-journal", "do not touch");
    await expect(inspectFileConsumerSnapshot(rollback)).rejects.toThrow("sidecars");
    expect(await readFile(rollback.databasePath + "-journal", "utf8")).toBe("do not touch");
    expect(await readdir(rollback.directory)).not.toContain("report.json");
  });

  it("runs the packaged command against a closed snapshot and reports malformed arguments", async () => {
    const f = await fixture();
    const cli = new URL("../inspect-file-consumers.mjs", import.meta.url);
    const result = JSON.parse(execFileSync(process.execPath, [cli.pathname, "--database", f.databasePath, "--output", f.outputPath, "--limit", "1"], { encoding: "utf8" }));
    expect(result).toMatchObject({ executable: false, bytesVerified: false, consumers: 1 });
    expect(() => execFileSync(process.execPath, [cli.pathname, "--database", f.databasePath, "--output", f.outputPath, "--limit", "1e2"], { stdio: "pipe" })).toThrow();
  }, 15_000);
});
