from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one deletion navigation anchor in {path}, found {count}: {old[:140]!r}")
    target.write_text(text.replace(old, new, 1))


def replace_exact(path: str, old: str, new: str, expected: int) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"expected {expected} deletion navigation anchors in {path}, found {count}: {old[:140]!r}")
    target.write_text(text.replace(old, new))


replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const ownedContentGenerationRef = useRef(0);
  const projectDeleteInputRef = useRef<ProjectLifecycleInput | null>(null);
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);
''',
    '''  const ownedContentGenerationRef = useRef(0);
  const projectDeleteInputRef = useRef<ProjectLifecycleInput | null>(null);
  const projectDeletionNavigationRequestedRef = useRef(false);
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
    (saveState !== "saved"
''',
    '''  const shouldBlockNavigation = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => (
    !projectDeletionNavigationRequestedRef.current
    && (saveState !== "saved"
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      projectDeleteInputRef.current = null;
      setProjectDeleteUncertain(false);
      setDeletingProject(false);
      navigate("/projects", { replace: true });
''',
    '''      projectDeleteInputRef.current = null;
      projectDeletionNavigationRequestedRef.current = true;
      setProjectDeleteUncertain(false);
      setDeletingProject(false);
      navigate("/projects", { replace: true });
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''        projectDeleteInputRef.current = null;
        setProjectDeleteUncertain(false);
        setDeletingProject(false);
        navigate("/projects", { replace: true });
''',
    '''        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = true;
        setProjectDeleteUncertain(false);
        setDeletingProject(false);
        navigate("/projects", { replace: true });
''',
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''        projectDeleteInputRef.current = null;
        setProjectDeleteUncertain(false);
        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");
''',
    '''        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = false;
        setProjectDeleteUncertain(false);
        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");
''',
)
replace_exact(
    "src/pages/ProjectPage.tsx",
    '''    projectDeleteInputRef.current = null;
    setProjectDeleteConfirmation("");
''',
    '''    projectDeleteInputRef.current = null;
    projectDeletionNavigationRequestedRef.current = false;
    setProjectDeleteConfirmation("");
''',
    2,
)
replace_once(
    "src/pages/ProjectPage.tsx",
    '''      projectDeleteInputRef.current = null;
      if (autosaveTimerRef.current !== null) {
''',
    '''      projectDeleteInputRef.current = null;
      projectDeletionNavigationRequestedRef.current = false;
      if (autosaveTimerRef.current !== null) {
''',
)
