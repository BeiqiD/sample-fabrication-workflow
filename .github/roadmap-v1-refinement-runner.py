from pathlib import Path
from textwrap import dedent

workflow = Path(".github/workflows/roadmap-v1-refinement.yml").read_text()
start_marker = "          python3 - <<'PY'\n"
end_marker = "\n          PY\n"
start = workflow.index(start_marker) + len(start_marker)
end = workflow.index(end_marker, start)
script = dedent(workflow[start:end])

old_call_start = script.index(
    'replace_once(\n    """- real-time collaboration before the single-user save/revision model is stable;'
)
old_call_end = script.index("\n\npath.write_text(text)", old_call_start)
replacement = '''replace_once(
    "- LLM features before the deterministic Project workflow is usable.\\n",
    """- systematic whole-product visual refinement before the v1 interaction shape is
  feature-frozen; functional UX required by Phase 3D is not deferred;
- near-term Docker/self-hosted implementation or a Docker-specific fork that
  distracts from completing and refining the v1 product;
- LLM features before the deterministic Project workflow is usable.
""",
)'''
script = script[:old_call_start] + replacement + script[old_call_end:]
exec(compile(script, "roadmap-v1-refinement", "exec"), {"__name__": "__main__"})
