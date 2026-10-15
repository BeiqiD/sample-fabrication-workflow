import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { stableJson } from "../../shared/domain/content-addressing";
import { readFileConsumerBaseline } from "../../worker/files/live-consumer-baseline";

type BaselineInput = NonNullable<Parameters<typeof readFileConsumerBaseline>[1]>;

/** A local, closed SQLite snapshot is an inspection input, never a restore
 * target. Refuse sidecars/WAL rather than opening a live database or silently
 * ignoring committed WAL rows. D1 uses the same reader through its primary
 * session; this CLI has no remote DB or provider capability. */
async function assertClosedSnapshot(path: string) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { await lstat(`${path}${suffix}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Database has SQLite sidecars; use a closed SQLite backup snapshot");
  }
}

function readOnlyAdapter(database: DatabaseSync) {
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind(...bindings: unknown[]) { return prepare(sql, bindings as SQLInputValue[]); },
    async all<T>() {
      return { success: true, results: database.prepare(sql).all(...values) as T[] };
    },
  });
  return { prepare };
}

async function publishNewReport(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Output already exists; choose a new report path");
      }
      throw error;
    }
  } finally { await rm(temporary, { force: true }); }
}

export async function inspectFileConsumerSnapshot(input: {
  databasePath: string;
  outputPath: string;
  limit?: BaselineInput["limit"];
  after?: BaselineInput["after"];
}) {
  const databasePath = await realpath(resolve(input.databasePath));
  const requestedOutput = resolve(input.outputPath);
  await mkdir(dirname(requestedOutput), { recursive: true });
  // Resolve the parent before comparing sidecar names, including a symlinked
  // directory alias. Publication uses this same canonical parent path.
  const outputPath = resolve(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  if (databasePath === outputPath || ["-wal", "-shm", "-journal"].some((suffix) => outputPath === `${databasePath}${suffix}`)) {
    throw new Error("Database and report output must be different paths");
  }
  await assertClosedSnapshot(databasePath);
  // O_NONBLOCK lets the regular-file test reject FIFOs without waiting for a writer.
  const file = await open(databasePath, constants.O_RDONLY | constants.O_NONBLOCK);
  let database: DatabaseSync | undefined;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Database input must be a regular SQLite file");
    const header = Buffer.alloc(100);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0") {
      throw new Error("Database input must be a SQLite database");
    }
    if (header[18] !== 1 || header[19] !== 1) {
      throw new Error("WAL databases require a closed SQLite backup snapshot before inspection");
    }
    database = new DatabaseSync(databasePath, { readOnly: true, enableForeignKeyConstraints: true, allowExtension: false });
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN");
    const report = await readFileConsumerBaseline(readOnlyAdapter(database), {
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
    database.exec("ROLLBACK");
    database.close(); database = undefined;
    const [after, current] = await Promise.all([file.stat({ bigint: true }), lstat(databasePath, { bigint: true })]);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Database snapshot changed during inspection; take a fresh SQLite backup");
    }
    await assertClosedSnapshot(databasePath);
    const encoded = `${stableJson(report)}\n`;
    await publishNewReport(outputPath, encoded);
    return {
      outputPath,
      reportSha256: createHash("sha256").update(encoded).digest("hex"),
      executable: false as const,
      bytesVerified: false as const,
      // A cursor is a pagination boundary, not a database revision or a lock.
      nextCursor: report.nextCursor,
      consumers: report.records.length,
    };
  } finally {
    try { database?.close(); } finally { await file.close(); }
  }
}
