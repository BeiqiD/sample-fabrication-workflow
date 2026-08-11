import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDirectory = fileURLToPath(new URL("../dist/client/assets/", import.meta.url));
const filenames = await readdir(assetsDirectory);
const mapChunks = filenames.filter((filename) => /^ProjectMapSurface-.*\.js$/.test(filename));
if (mapChunks.length !== 1) {
  throw new Error(`Expected one lazy ProjectMapSurface JavaScript chunk, found ${mapChunks.length}`);
}

const mapChunkPath = join(assetsDirectory, mapChunks[0]);
const mapChunkStat = await stat(mapChunkPath);
if (mapChunkStat.size < 50_000) {
  throw new Error("ProjectMapSurface chunk is unexpectedly small; React Flow may not be owned by it");
}

const entryChunks = filenames.filter((filename) => /^index-.*\.js$/.test(filename));
if (!entryChunks.length) throw new Error("Client entry chunk was not found");

for (const filename of entryChunks) {
  const source = await readFile(join(assetsDirectory, filename), "utf8");
  if (/react-flow__|xyflow|ReactFlow/.test(source)) {
    throw new Error(`React Flow leaked into initial client entry ${filename}`);
  }
}

const mapSource = await readFile(mapChunkPath, "utf8");
if (!/react-flow__|ReactFlow/.test(mapSource)) {
  throw new Error("The lazy ProjectMapSurface chunk does not contain the expected React Flow runtime");
}

console.log(`Verified desktop-only React Flow ownership in ${mapChunks[0]}`);
