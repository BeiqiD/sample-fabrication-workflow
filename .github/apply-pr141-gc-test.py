#!/usr/bin/env python3
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "worker/blob-gc.test.ts"
text = path.read_text()
old = '''    ASSETS: { delete: assetDelete, put: options.assetPut ?? vi.fn(async () => undefined) },
'''
new = '''    ASSETS: {
      delete: assetDelete,
      put: options.assetPut ?? vi.fn(async () => undefined),
      head: async (key: string) => {
        const row = database.prepare(`
          SELECT byte_size FROM assets WHERE r2_key = ?
        `).get(key) as { byte_size: number } | undefined;
        if (!row) return null;
        return {
          size: Number(row.byte_size),
          httpEtag: '\"blob-gc-test\"',
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "application/octet-stream");
          },
        };
      },
      get: async (key: string) => {
        const row = database.prepare(`
          SELECT byte_size FROM assets WHERE r2_key = ?
        `).get(key) as { byte_size: number } | undefined;
        if (!row) return null;
        const bytes = new Uint8Array(Number(row.byte_size));
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          size: bytes.byteLength,
          httpEtag: '\"blob-gc-test\"',
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "application/octet-stream");
          },
        };
      },
    },
'''
count = text.count(old)
if count != 1:
    raise RuntimeError(f"expected one blob-gc env target, found {count}")
path.write_text(text.replace(old, new, 1))
