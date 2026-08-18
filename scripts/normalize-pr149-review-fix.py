from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one normalization replacement, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "src/lib/project-client.ts",
    '''    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      projectMutationDisposition?: unknown;
    };
    const mutationDisposition = payload.projectMutationDisposition === "authoritative-rejection"
      ? payload.projectMutationDisposition
      : null;
''',
    '''    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
    };
    const mutationDisposition = response.headers.get("x-project-mutation-disposition")
      === "authoritative-rejection"
      ? "authoritative-rejection"
      : null;
''',
)

replace_once(
    "worker/project-routes.ts",
    '''  if (error instanceof HTTPException && (error.status === 404 || error.status === 409)) {
    return c.json({
      error: error.message,
      projectMutationDisposition: "authoritative-rejection" as const,
    }, error.status);
  }
''',
    '''  if (error instanceof HTTPException && (error.status === 404 || error.status === 409)) {
    c.header("x-project-mutation-disposition", "authoritative-rejection");
    return c.json({ error: error.message }, error.status);
  }
''',
)

replace_once(
    "worker/project-routes.test.ts",
    '''    expect(staleMove.status).toBe(409);
    expect(await staleMove.json()).toMatchObject({
      error: "Placement revision conflict",
      projectMutationDisposition: "authoritative-rejection",
    });
''',
    '''    expect(staleMove.status).toBe(409);
    expect(staleMove.headers.get("x-project-mutation-disposition")).toBe("authoritative-rejection");
    expect(await staleMove.json()).toMatchObject({ error: "Placement revision conflict" });
''',
)

replace_once(
    "src/project-canvas-paste-abandon.mount.test.tsx",
    '''        return jsonResponse({
          error: "Project revision conflict",
          projectMutationDisposition: "authoritative-rejection",
        }, 409);
''',
    '''        return Promise.resolve(new Response(JSON.stringify({
          error: "Project revision conflict",
        }), {
          status: 409,
          headers: {
            "content-type": "application/json",
            "x-project-mutation-disposition": "authoritative-rejection",
          },
        }));
''',
)

contract = Path("docs/PROJECT_CANVAS_COPY_PASTE_CONTRACT.md")
text = contract.read_text()
old = '`projectMutationDisposition: "authoritative-rejection"`'
new = '`x-project-mutation-disposition: authoritative-rejection`'
if text.count(old) != 1:
    raise SystemExit(f"copy/paste contract: expected one disposition reference, found {text.count(old)}")
contract.write_text(text.replace(old, new, 1))

print("Normalized PR #149 authoritative settlement marker to a response header")
