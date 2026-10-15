import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { FetchHandler } from "./http.ts";

const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm" };
function inside(root: string, path: string) { const part = relative(root, path); return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part)); }
function failure(status: number) { return new Response(status === 404 ? "Not found" : "Static asset unavailable", { status }); }

/** Reviewed, server-owned build directory only; API routes never enter SPA fallback. */
export async function createStaticAssetsHandler(options: {
  directory: string;
  api: FetchHandler;
  /** Explicit admission from the composition's reviewed client route graph. */
  isSpaPath: (decodedPath: string) => boolean;
}): Promise<FetchHandler> {
  const requestedRoot = resolve(options.directory);
  const root = await realpath(requestedRoot);
  if (root !== requestedRoot || !(await lstat(root)).isDirectory()) throw new Error("Configure a canonical build directory");
  async function file(name: string): Promise<FileHandle | null> {
    const path = resolve(root, name);
    if (!inside(root, path)) throw new Error("Invalid static path");
    let cursor = root;
    const components = relative(root, path).split(sep);
    for (const [index, part] of components.entries()) {
      cursor = resolve(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) throw Object.assign(new Error("Static symlinks are unsupported"), { code: "EACCES" });
        if (index === components.length - 1 ? !info.isFile() : !info.isDirectory()) return null;
      }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
    }
    let handle: FileHandle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null; throw error; }
    try { if (!(await handle.stat()).isFile()) { await handle.close(); return null; } }
    catch (error) { await handle.close(); throw error; }
    return handle;
  }
  return async (request) => {
    const url = new URL(request.url);
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return failure(400); }
    const parts = path.split("/").filter(Boolean);
    if (/[\\\x00-\x1f\x7f]/.test(path) || /%2f|%5c/i.test(url.pathname)
      || parts.some(part => part === "." || part === ".." || part.startsWith("."))) return failure(400);
    // Reserve decoded API spelling too; an encoded prefix never becomes SPA HTML.
    if (path === "/api" || path.startsWith("/api/")) return options.api(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const name = parts.join("/") || "index.html";
    let handle: FileHandle | null = null;
    try {
      handle = await file(name);
      let servedName = name;
      if (!handle && parts[0] !== "assets" && options.isSpaPath(path) && request.headers.get("accept")?.includes("text/html")) {
        servedName = "index.html"; handle = await file(servedName);
      }
      if (!handle) return failure(404);
      const info = await handle.stat();
      const headers = { "content-type": mime[extname(servedName).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(info.size), "x-content-type-options": "nosniff", "cache-control": "no-cache" };
      if (request.method === "HEAD") { await handle.close(); handle = null; return new Response(null, { headers }); }
      const stream = handle.createReadStream({ autoClose: true }); handle = null;
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
    } catch (error) {
      await handle?.close();
      return failure(["EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "") ? 403 : 500);
    }
  };
}
