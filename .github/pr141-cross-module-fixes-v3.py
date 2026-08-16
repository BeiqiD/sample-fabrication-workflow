from pathlib import Path

path = Path(".github/pr141-cross-module-fixes-v2.py")
source = path.read_text()
start = "adapter_section = r'''# Reference adapters resolve"
end = "\n'''\n\nsource = source[:section_start]"
if source.count(start) != 1 or source.count(end) != 1:
    raise SystemExit("Could not repair adapter-section quoting")
source = source.replace(
    start,
    'adapter_section = r"""# Reference adapters resolve',
    1,
).replace(
    end,
    '\n"""\n\nsource = source[:section_start]',
    1,
)
exec(compile(source, str(path), "exec"), {"__name__": "__main__"})
