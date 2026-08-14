from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


page = Path("src/pages/ProjectPage.tsx")
text = page.read_text()
text = text.replace("projectDeleteInputRef", "projectDeleteRequestRef")
page.write_text(text)

replace_once(
    "src/pages/ProjectPage.tsx",
    'type ProjectWorkspaceView = "map" | "reading";\n',
    '''type ProjectWorkspaceView = "map" | "reading";\n\ntype ProjectDeletionRequest = {\n  projectId: string;\n  input: ProjectLifecycleInput;\n};\n''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const { projectId = "" } = useParams();\n  const navigate = useNavigate();\n''',
    '''  const { projectId = "" } = useParams();\n  const navigate = useNavigate();\n  const projectIdRef = useRef(projectId);\n  projectIdRef.current = projectId;\n''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '  const projectDeleteRequestRef = useRef<ProjectLifecycleInput | null>(null);\n',
    '  const projectDeleteRequestRef = useRef<ProjectDeletionRequest | null>(null);\n',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const performProjectDeletion = useCallback(async (input: ProjectLifecycleInput) => {\n    if (!projectId || !pageActiveRef.current) return;\n    setDeletingProject(true);\n    setProjectDeleteError("");\n    try {\n      await projectApi.deleteProject(projectId, input);\n      if (!pageActiveRef.current) return;\n      projectDeleteRequestRef.current = null;\n      projectDeletionNavigationRequestedRef.current = true;\n      setProjectDeleteUncertain(false);\n      setDeletingProject(false);\n      navigate("/projects", { replace: true });\n    } catch (caught) {\n      if (!pageActiveRef.current) return;\n      if (caught instanceof ProjectApiError && caught.status === 404) {\n        projectDeleteRequestRef.current = null;\n        projectDeletionNavigationRequestedRef.current = true;\n        setProjectDeleteUncertain(false);\n        setDeletingProject(false);\n        navigate("/projects", { replace: true });\n        return;\n      }\n      if (caught instanceof ProjectApiError && caught.status === 409) {\n        projectDeleteRequestRef.current = null;\n        projectDeletionNavigationRequestedRef.current = false;\n        setProjectDeleteUncertain(false);\n        setProjectDeleteConfirmation("");\n        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");\n        await loadProject();\n        return;\n      }\n      const uncertain = projectDeletionOutcomeIsUncertain(caught);\n      setProjectDeleteUncertain(uncertain);\n      setProjectDeleteError(caught instanceof Error\n        ? caught.message\n        : "The Project could not be moved to trash");\n    } finally {\n      if (pageActiveRef.current) setDeletingProject(false);\n    }\n  }, [loadProject, navigate, projectId]);\n''',
    '''  const performProjectDeletion = useCallback(async (request: ProjectDeletionRequest) => {\n    const requestIsCurrent = () => (\n      pageActiveRef.current\n      && projectIdRef.current === request.projectId\n      && projectDeleteRequestRef.current === request\n    );\n    if (!request.projectId || !requestIsCurrent()) return;\n    setDeletingProject(true);\n    setProjectDeleteError("");\n    try {\n      await projectApi.deleteProject(request.projectId, request.input);\n      if (!requestIsCurrent()) return;\n      projectDeleteRequestRef.current = null;\n      projectDeletionNavigationRequestedRef.current = true;\n      setProjectDeleteUncertain(false);\n      setDeletingProject(false);\n      navigate("/projects", { replace: true });\n    } catch (caught) {\n      if (!requestIsCurrent()) return;\n      if (caught instanceof ProjectApiError && caught.status === 404) {\n        projectDeleteRequestRef.current = null;\n        projectDeletionNavigationRequestedRef.current = true;\n        setProjectDeleteUncertain(false);\n        setDeletingProject(false);\n        navigate("/projects", { replace: true });\n        return;\n      }\n      if (caught instanceof ProjectApiError && caught.status === 409) {\n        projectDeleteRequestRef.current = null;\n        projectDeletionNavigationRequestedRef.current = false;\n        setProjectDeleteUncertain(false);\n        setProjectDeleteConfirmation("");\n        setProjectDeleteError("The Project changed before it could be moved to trash. The latest authoritative state has been reloaded; review it and confirm again.");\n        await loadProject();\n        return;\n      }\n      const uncertain = projectDeletionOutcomeIsUncertain(caught);\n      setProjectDeleteUncertain(uncertain);\n      setProjectDeleteError(caught instanceof Error\n        ? caught.message\n        : "The Project could not be moved to trash");\n    } finally {\n      if (pageActiveRef.current && projectIdRef.current === request.projectId) setDeletingProject(false);\n    }\n  }, [loadProject, navigate]);\n''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const openProjectDeletion = useCallback(() => {\n    if (saveStateRef.current !== "saved"\n      || pendingReferenceRef.current\n      || pendingReferenceRemovalRef.current\n      || markdownEditorRef.current\n      || pendingAttachmentRef.current\n      || attachmentEditorRef.current\n      || edgeController.unsafeRef.current) return;\n    projectDeleteRequestRef.current = null;\n    projectDeletionNavigationRequestedRef.current = false;\n    setProjectDeleteConfirmation("");\n    setProjectDeleteError("");\n    setProjectDeleteUncertain(false);\n    setConfirmingProjectDeletion(true);\n  }, [edgeController.unsafeRef]);\n''',
    '''  const openProjectDeletion = useCallback(() => {\n    if (!snapshot || !projectId || snapshot.project.id !== projectId\n      || saveStateRef.current !== "saved"\n      || pendingReferenceRef.current\n      || pendingReferenceRemovalRef.current\n      || markdownEditorRef.current\n      || pendingAttachmentRef.current\n      || attachmentEditorRef.current\n      || edgeController.unsafeRef.current) return;\n    projectDeleteRequestRef.current = null;\n    projectDeletionNavigationRequestedRef.current = false;\n    setProjectDeleteConfirmation("");\n    setProjectDeleteError("");\n    setProjectDeleteUncertain(false);\n    setConfirmingProjectDeletion(true);\n  }, [edgeController.unsafeRef, projectId, snapshot]);\n''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  const moveProjectToTrash = useCallback(() => {\n    if (!snapshot || deletingProject || projectDeleteConfirmation !== snapshot.project.title) return;\n    if (!projectDeleteRequestRef.current) {\n      if (saveStateRef.current !== "saved"\n        || pendingReferenceRef.current\n        || pendingReferenceRemovalRef.current\n        || markdownEditorRef.current\n        || pendingAttachmentRef.current\n        || attachmentEditorRef.current\n        || edgeController.unsafeRef.current) return;\n      projectDeleteRequestRef.current = {\n        expectedRevision: snapshot.project.revision,\n        operationId: createProjectApiId("operation"),\n      };\n    }\n    void performProjectDeletion(projectDeleteRequestRef.current);\n  }, [deletingProject, edgeController.unsafeRef, performProjectDeletion, projectDeleteConfirmation, snapshot]);\n''',
    '''  const moveProjectToTrash = useCallback(() => {\n    if (!projectId || !snapshot || snapshot.project.id !== projectId\n      || deletingProject || projectDeleteConfirmation !== snapshot.project.title) return;\n    let request = projectDeleteRequestRef.current;\n    if (request && request.projectId !== projectId) {\n      projectDeleteRequestRef.current = null;\n      projectDeletionNavigationRequestedRef.current = false;\n      setProjectDeleteUncertain(false);\n      setProjectDeleteError("");\n      return;\n    }\n    if (!request) {\n      if (saveStateRef.current !== "saved"\n        || pendingReferenceRef.current\n        || pendingReferenceRemovalRef.current\n        || markdownEditorRef.current\n        || pendingAttachmentRef.current\n        || attachmentEditorRef.current\n        || edgeController.unsafeRef.current) return;\n      request = {\n        projectId,\n        input: {\n          expectedRevision: snapshot.project.revision,\n          operationId: createProjectApiId("operation"),\n        },\n      };\n      projectDeleteRequestRef.current = request;\n    }\n    void performProjectDeletion(request);\n  }, [deletingProject, edgeController.unsafeRef, performProjectDeletion, projectDeleteConfirmation, projectId, snapshot]);\n''',
)

replace_once(
    "src/pages/ProjectPage.tsx",
    '''  useEffect(() => {\n    const controller = new AbortController();\n    void loadProject(controller.signal);\n    return () => controller.abort();\n  }, [loadProject]);\n''',
    '''  useEffect(() => {\n    projectDeleteRequestRef.current = null;\n    projectDeletionNavigationRequestedRef.current = false;\n    setConfirmingProjectDeletion(false);\n    setProjectDeleteConfirmation("");\n    setProjectDeleteError("");\n    setProjectDeleteUncertain(false);\n    setDeletingProject(false);\n  }, [projectId]);\n\n  useEffect(() => {\n    const controller = new AbortController();\n    void loadProject(controller.signal);\n    return () => controller.abort();\n  }, [loadProject]);\n''',
)

# The deletion ref is request-bound everywhere after the rename. The unmount cleanup,
# beforeunload guard, and responsive lock intentionally retain their existing semantics.

replace_once(
    "src/project-deletion.mount.test.tsx",
    'import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";\n',
    'import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";\n',
)

replace_once(
    "src/project-deletion.mount.test.tsx",
    '''function renderProjectPage() {\n  const router = createMemoryRouter([{\n    path: "/projects/:projectId",\n    element: <ProjectPage />,\n  }, {\n    path: "/projects",\n    element: <div>Projects destination</div>,\n  }], { initialEntries: ["/projects/project-a"] });\n  return render(<RouterProvider router={router} />);\n}\n''',
    '''function renderProjectPage() {\n  const router = createMemoryRouter([{\n    path: "/projects/:projectId",\n    element: <ProjectPage />,\n  }, {\n    path: "/projects",\n    element: <div>Projects destination</div>,\n  }], { initialEntries: ["/projects/project-a"] });\n  return { router, view: render(<RouterProvider router={router} />) };\n}\n''',
)

new_test = r'''

  it("does not carry a deterministic deletion request across Project route identities", async () => {
    const projectA = projectTestSnapshot();
    const projectB = projectTestSnapshot();
    projectB.project = {
      ...projectB.project,
      id: "project-b",
      title: projectA.project.title,
      revision: projectA.project.revision,
      updatedAt: "2026-08-14T10:00:00.000Z",
    };
    projectB.contents = projectB.contents.map((content) => ({ ...content, projectId: "project-b" }));
    projectB.items = projectB.items.map((item) => ({ ...item, projectId: "project-b" }));

    const deletionCalls: Array<{
      projectId: string;
      expectedRevision: number;
      operationId: string;
    }> = [];
    let projectBReads = 0;

    fetchMock.mockImplementation((path, init) => {
      const url = String(path);
      if (url === "/api/projects/project-a" && !init?.method) return jsonResponse(projectA);
      if (url === "/api/projects/project-b" && !init?.method) {
        projectBReads += 1;
        return jsonResponse(projectB);
      }
      if ((url === "/api/projects/project-a" || url === "/api/projects/project-b") && init?.method === "DELETE") {
        const input = JSON.parse(String(init.body)) as { expectedRevision: number; operationId: string };
        const targetProjectId = url.endsWith("project-a") ? "project-a" : "project-b";
        deletionCalls.push({ projectId: targetProjectId, ...input });
        if (targetProjectId === "project-a") {
          return jsonResponse({ error: "Project deletion rejected" }, 400);
        }
        return jsonResponse({
          project: {
            ...projectB.project,
            revision: projectB.project.revision + 1,
            deletedAt: "2026-08-14T10:05:00.000Z",
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

    expect(await screen.findByText("Project deletion rejected")).toBeTruthy();
    expect(deletionCalls).toHaveLength(1);
    expect(deletionCalls[0]).toMatchObject({
      projectId: "project-a",
      expectedRevision: projectA.project.revision,
    });
    const projectAOperationId = deletionCalls[0].operationId;
    expect((screen.getByLabelText("Type the Project title to confirm") as HTMLInputElement).value)
      .toBe(projectA.project.title);

    await act(async () => {
      await router.navigate("/projects/project-b");
    });
    await waitFor(() => expect(projectBReads).toBeGreaterThan(0));
    await screen.findByText("Project Map fixture");
    expect(screen.queryByRole("alertdialog", { name: "Move Project to trash" })).toBeNull();
    expect(deletionCalls).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    dialog = await screen.findByRole("alertdialog", { name: "Move Project to trash" });
    const confirmation = screen.getByLabelText("Type the Project title to confirm") as HTMLInputElement;
    expect(confirmation.value).toBe("");
    fireEvent.change(confirmation, { target: { value: projectB.project.title } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    await screen.findByText("Projects destination");
    expect(deletionCalls).toHaveLength(2);
    expect(deletionCalls[1]).toMatchObject({
      projectId: "project-b",
      expectedRevision: projectB.project.revision,
    });
    expect(deletionCalls[1].operationId).not.toBe(projectAOperationId);
  });
'''

replace_once(
    "src/project-deletion.mount.test.tsx",
    '''    expect(deleteInputs[1].operationId).not.toBe(deleteInputs[0].operationId);\n  });\n\n});\n''',
    '''    expect(deleteInputs[1].operationId).not.toBe(deleteInputs[0].operationId);\n  });\n''' + new_test + '''\n});\n''',
)
