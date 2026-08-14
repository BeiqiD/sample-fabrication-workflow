from pathlib import Path

path = Path("worker/project-routes.test.ts")
text = path.read_text()
old = 'import { describe, expect, it } from "vitest";'
new = 'import { describe, expect, it, vi } from "vitest";'
if text.count(old) != 1:
    raise SystemExit("worker/project-routes.test.ts: expected the vitest import once")
path.write_text(text.replace(old, new, 1))
