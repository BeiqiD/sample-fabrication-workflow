from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:180]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "src/pages/ProjectPage.tsx",
    '''function projectDeletionOutcomeIsUncertain(caught: unknown) {
  if (!(caught instanceof ProjectApiError)) return true;
  return caught.status === 408 || caught.status === 429 || caught.status >= 500;
}

export function ProjectPage() {
''',
    '''function projectDeletionOutcomeIsUncertain(caught: unknown) {
  if (!(caught instanceof ProjectApiError)) return true;
  return caught.status === 408 || caught.status === 429 || caught.status >= 500;
}

type ProjectDeletionRequest = {
  projectId: string;
  input: ProjectLifecycleInput;
};

export function ProjectPage() {
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const referenceNavigationRequestedRef = useRef(false);
  const pageActiveRef = useRef(true);
  const saveSessionGenerationRef = useRef(0);
''',
    '''  const referenceNavigationRequestedRef = useRef(false);
  const pageActiveRef = useRef(true);
  const projectIdRef = useRef(projectId);
  const saveSessionGenerationRef = useRef(0);
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const ownedContentGenerationRef = useRef(0);
  const projectDeleteInputRef = useRef<ProjectLifecycleInput | null>(null);
  const projectDeletionNavigationRequestedRef = useRef(false);
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);

  const updatePendingReference = useCallback((next: ProjectPendingReferencePlacement | null) => {
''',
    '''  const ownedContentGenerationRef = useRef(0);
  const projectDeleteInputRef = useRef<ProjectDeletionRequest | null>(null);
  const projectDeletionNavigationRequestedRef = useRef(false);
  const mapSurfaceRef = useRef<ProjectMapSurfaceHandle | null>(null);

  projectIdRef.current = projectId;

  const updatePendingReference = useCallback((next: ProjectPendingReferencePlacement | null) => {
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const loadProject = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) return;
    setLoading(true);
    try {
      const next = await projectApi.read(projectId, signal);
      installSnapshot(next);
      setLoadError("");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (caught instanceof Error && caught.name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "The Project could not be opened");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [installSnapshot, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [loadProject]);

  const performProjectDeletion = useCallback(async (input: ProjectLifecycleInput) => {
    if (!projectId || !pageActiveRef.current) return;
    setDeletingProject(true);
    setProjectDeleteError("");
    try {
      await projectApi.deleteProject(projectId, input);
      if (!pageActiveRef.current) return;
      projectDeleteInputRef.current = null;
      projectDeletionNavigationRequestedRef.current = true;
      setProjectDeleteUncertain(false);
      setDeletingProject(false);
      navigate("/projects", { replace: true });
    } catch (caught) {
      if (!pageActiveRef.current) return;
      if (caught instanceof ProjectApiError && caught.status === 404) {
        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = true;
        setProjectDeleteUncertain(false);
        setDeletingProject(false);
        navigate("/projects", { replace: true });
        return;
      }
      if (caught instanceof ProjectApiError && caught.status === 409) {
        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = false;
        setProjectDeleteUncertain(false);
        setProjectDeleteConfirmation("");
        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");
        await loadProject();
        return;
      }
      const uncertain = projectDeletionOutcomeIsUncertain(caught);
      setProjectDeleteUncertain(uncertain);
      setProjectDeleteError(caught instanceof Error
        ? caught.message
        : "The Project could not be moved to trash");
    } finally {
      if (pageActiveRef.current) setDeletingProject(false);
    }
  }, [loadProject, navigate, projectId]);
''',
    '''  const loadProject = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) return;
    const targetProjectId = projectId;
    setLoading(true);
    try {
      const next = await projectApi.read(targetProjectId, signal);
      if (!pageActiveRef.current || projectIdRef.current !== targetProjectId) return;
      installSnapshot(next);
      setLoadError("");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (caught instanceof Error && caught.name === "AbortError") return;
      if (!pageActiveRef.current || projectIdRef.current !== targetProjectId) return;
      setLoadError(caught instanceof Error ? caught.message : "The Project could not be opened");
    } finally {
      if (!signal?.aborted && pageActiveRef.current && projectIdRef.current === targetProjectId) setLoading(false);
    }
  }, [installSnapshot, projectId]);

  useEffect(() => {
    projectDeleteInputRef.current = null;
    projectDeletionNavigationRequestedRef.current = false;
    setConfirmingProjectDeletion(false);
    setProjectDeleteConfirmation("");
    setProjectDeleteError("");
    setProjectDeleteUncertain(false);
    setDeletingProject(false);
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [loadProject]);

  const performProjectDeletion = useCallback(async (request: ProjectDeletionRequest) => {
    const targetProjectId = request.projectId;
    if (!targetProjectId || !pageActiveRef.current || projectIdRef.current !== targetProjectId) return;
    setDeletingProject(true);
    setProjectDeleteError("");
    try {
      await projectApi.deleteProject(targetProjectId, request.input);
      if (!pageActiveRef.current || projectIdRef.current !== targetProjectId) return;
      projectDeleteInputRef.current = null;
      projectDeletionNavigationRequestedRef.current = true;
      setProjectDeleteUncertain(false);
      setDeletingProject(false);
      navigate("/projects", { replace: true });
    } catch (caught) {
      if (!pageActiveRef.current || projectIdRef.current !== targetProjectId) return;
      if (caught instanceof ProjectApiError && caught.status === 404) {
        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = true;
        setProjectDeleteUncertain(false);
        setDeletingProject(false);
        navigate("/projects", { replace: true });
        return;
      }
      if (caught instanceof ProjectApiError && caught.status === 409) {
        projectDeleteInputRef.current = null;
        projectDeletionNavigationRequestedRef.current = false;
        setProjectDeleteUncertain(false);
        setProjectDeleteConfirmation("");
        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");
        await loadProject();
        return;
      }
      const uncertain = projectDeletionOutcomeIsUncertain(caught);
      setProjectDeleteUncertain(uncertain);
      setProjectDeleteError(caught instanceof Error
        ? caught.message
        : "The Project could not be moved to trash");
    } finally {
      if (pageActiveRef.current && projectIdRef.current === targetProjectId) setDeletingProject(false);
    }
  }, [loadProject, navigate]);
''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const moveProjectToTrash = useCallback(() => {
    if (!snapshot || deletingProject || projectDeleteConfirmation !== snapshot.project.title) return;
    if (!projectDeleteInputRef.current) {
      if (saveStateRef.current !== "saved"
        || pendingReferenceRef.current
        || pendingReferenceRemovalRef.current
        || markdownEditorRef.current
        || pendingAttachmentRef.current
        || attachmentEditorRef.current
        || edgeController.unsafeRef.current) return;
      projectDeleteInputRef.current = {
        expectedRevision: snapshot.project.revision,
        operationId: createProjectApiId("operation"),
      };
    }
    void performProjectDeletion(projectDeleteInputRef.current);
  }, [deletingProject, edgeController.unsafeRef, performProjectDeletion, projectDeleteConfirmation, snapshot]);
''',
    '''  const moveProjectToTrash = useCallback(() => {
    if (!snapshot || !projectId || deletingProject || projectDeleteConfirmation !== snapshot.project.title) return;
    let request = projectDeleteInputRef.current;
    if (request && request.projectId !== projectId) {
      projectDeleteInputRef.current = null;
      request = null;
    }
    if (!request) {
      if (saveStateRef.current !== "saved"
        || pendingReferenceRef.current
        || pendingReferenceRemovalRef.current
        || markdownEditorRef.current
        || pendingAttachmentRef.current
        || attachmentEditorRef.current
        || edgeController.unsafeRef.current) return;
      request = {
        projectId,
        input: {
          expectedRevision: snapshot.project.revision,
          operationId: createProjectApiId("operation"),
        },
      };
      projectDeleteInputRef.current = request;
    }
    void performProjectDeletion(request);
  }, [deletingProject, edgeController.unsafeRef, performProjectDeletion, projectDeleteConfirmation, projectId, snapshot]);
''',
)

replace_once(
    "src/project-deletion.mount.test.tsx",
    '''function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }, {
    path: "/projects",
    element: <div>Projects destination</div>,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}
''',
    '''function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }, {
    path: "/projects",
    element: <div>Projects destination</div>,
  }], { initialEntries: ["/projects/project-a"] });
  return { router, view: render(<RouterProvider router={router} />) };
}
''',
)

cross_project_test = r'''

  it("does not reuse a deterministic deletion request after the route switches to another same-title Project", async () => {
    const projectA = projectTestSnapshot();
    const projectB = projectTestSnapshot();
    projectB.project = { ...projectB.project, id: "project-b" };
    projectB.contents = projectB.contents.map((content) => ({ ...content, projectId: "project-b" }));
    projectB.items = projectB.items.map((item) => ({ ...item, projectId: "project-b" }));

    const deleteInputs: Array<{ projectId: string; expectedRevision: number; operationId: string }> = [];
    fetchMock.mockImplementation((path, init) => {
      const url = String(path);
      if (url === "/api/projects/project-a" && !init?.method) return jsonResponse(projectA);
      if (url === "/api/projects/project-b" && !init?.method) return jsonResponse(projectB);
      if ((url === "/api/projects/project-a" || url === "/api/projects/project-b") && init?.method === "DELETE") {
        const input = JSON.parse(String(init.body)) as { expectedRevision: number; operationId: string };
        const targetProjectId = url.endsWith("project-a") ? "project-a" : "project-b";
        deleteInputs.push({ projectId: targetProjectId, ...input });
        if (targetProjectId === "project-a") return jsonResponse({ error: "Deterministic Project deletion failure" }, 400);
        return jsonResponse({
          project: {
            ...projectB.project,
            revision: projectB.project.revision + 1,
            deletedAt: "2026-08-14T10:30:00.000Z",
            deletedBy: "user@example.com",
          },
          replayed: false,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${url}` }, 500);
    });

    const { router } = renderProjectPage();
    await screen.findByText("Project Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: projectA.project.title },
    });
    let dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    expect(await screen.findByText("Deterministic Project deletion failure")).toBeTruthy();
    expect(deleteInputs).toHaveLength(1);
    expect(deleteInputs[0]).toMatchObject({
      projectId: "project-a",
      expectedRevision: projectA.project.revision,
    });

    await router.navigate("/projects/project-b");
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/projects/project-b" && !init?.method)).toBe(true);
      expect(screen.queryByRole("alertdialog", { name: "Move Project to trash" })).toBeNull();
      expect(screen.queryByText("Deterministic Project deletion failure")).toBeNull();
    });
    expect(deleteInputs).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    expect((screen.getByLabelText("Type the Project title to confirm") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Type the Project title to confirm"), {
      target: { value: projectB.project.title },
    });
    dialog = screen.getByRole("alertdialog", { name: "Move Project to trash" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    await screen.findByText("Projects destination");
    expect(deleteInputs).toHaveLength(2);
    expect(deleteInputs[1]).toMatchObject({
      projectId: "project-b",
      expectedRevision: projectB.project.revision,
    });
    expect(deleteInputs[1].operationId).not.toBe(deleteInputs[0].operationId);
  });
'''

replace_once(
    "src/project-deletion.mount.test.tsx",
    '''  it("requires a fresh title confirmation and lifecycle identity after a deletion conflict", async () => {
''',
    cross_project_test + '''\n  it("requires a fresh title confirmation and lifecycle identity after a deletion conflict", async () => {\n''',
)
