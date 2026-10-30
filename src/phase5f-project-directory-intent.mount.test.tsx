import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateProjectInput } from "../shared/project-api";
import { ProjectsPage } from "./pages/ProjectsPage";
import { readAuthentication, signIn, signOut } from "./lib/authentication-client";
import { PROJECT_CREATION_SUBJECT_HEADER, PROJECT_CREATION_SUBJECT_RESULT_HEADER } from "../shared/project-creation-subject";

const subject = "a".repeat(64), intentKey = `project-directory-create-intent:${subject}`, network = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", [PROJECT_CREATION_SUBJECT_HEADER]: subject, ...headers },
});
const receipt = (input: CreateProjectInput, replayed = false) => ({ project: {
  id: input.id, title: input.title, revision: 1, nextCreatedSequence: 1,
  createdBy: "synthetic-owner", updatedBy: "synthetic-owner",
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
  deletedAt: null, deletedBy: null,
}, replayed });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function mount() {
  const router = createMemoryRouter([{ path: "/projects", element: <ProjectsPage /> },
    { path: "/projects/:projectId", element: <p>Opened Project</p> },
    { path: "/elsewhere", element: <p>Another page</p> }], { initialEntries: ["/projects"] });
  const view = render(<RouterProvider router={router} />); return { ...view, router };
}
async function open(title = "Retained research question") {
  await screen.findByText("No Projects yet");
  fireEvent.click(screen.getByRole("button", { name: "Create first Project" }));
  const form = screen.getByRole("form", { name: "Create Project" });
  fireEvent.change(within(form).getByLabelText("Project title"), { target: { value: title } });
  return form;
}
const posts = () => network.mock.calls.filter(([, options]) => options?.method === "POST");
const body = (options: RequestInit | undefined): CreateProjectInput => JSON.parse(String(options?.body));
beforeEach(() => { sessionStorage.clear(); network.mockReset(); vi.stubGlobal("fetch", network);
  network.mockImplementation(async () => json({ projects: [] })); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); sessionStorage.clear(); });

// Synthetic transport/receipt controls. Actual Worker replay is qualified by a
// separate finite browser case; these cases make no real persistence claim.
describe("5F Project directory request ownership", () => {
  it("retains a lost creation response across closing the form and explicitly retries its exact input", async () => {
    const accepted = new Map<string, CreateProjectInput>();
    network.mockImplementation(async (_path, options) => {
      if (options?.method !== "POST") return json({ projects: [] });
      const input = body(options);
      expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(input);
      if (!accepted.has(input.id)) { accepted.set(input.id, input); throw new Error("The accepted response was lost"); }
      expect(input).toEqual(accepted.get(input.id)); return json(receipt(input, true));
    });
    const view = mount(), form = await open();
    fireEvent.submit(form);
    expect((await within(form).findByRole("alert")).textContent).toContain("accepted response was lost");
    expect((within(form).getByLabelText("Project title") as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Create Project" })).toBeNull();
    expect((screen.getByRole("button", { name: "New Project" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review unconfirmed Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry Project creation" }));
    await screen.findByText("Opened Project");
    expect(posts()).toHaveLength(2); expect(posts()[0]![1]?.body).toBe(posts()[1]![1]?.body);
    expect(accepted.size).toBe(1); expect(sessionStorage.getItem(intentKey)).toBeNull();
    expect(view.router.state.location.pathname).toBe(`/projects/${body(posts()[0]![1]).id}`);
  });

  it("restores an unconfirmed original input after route exit without automatically sending it", async () => {
    network.mockImplementation(async (_path, options) => options?.method === "POST"
      ? json({ error: "Confirmation unavailable" }, 503) : json({ projects: [] }));
    const view = mount(), form = await open("A title retained through navigation"); fireEvent.submit(form);
    await within(form).findByRole("alert"); const original = posts()[0]![1]?.body;
    await act(() => view.router.navigate("/elsewhere")); await screen.findByText("Another page");
    await act(() => view.router.navigate("/projects"));
    const restored = await screen.findByRole("form", { name: "Create Project" });
    const title = within(restored).getByLabelText("Project title") as HTMLInputElement;
    expect(title.value).toBe("A title retained through navigation"); expect(title.readOnly).toBe(true);
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.click(within(restored).getByRole("button", { name: "Retry Project creation" }));
    await within(restored).findByRole("alert"); expect(posts()).toHaveLength(2);
    expect(posts()[1]![1]?.body).toBe(original);
  });

  it("owns a pending submit synchronously and keeps close disabled until the original transport settles", async () => {
    const held = deferred<Response>();
    network.mockImplementation(async (_path, options) => options?.method === "POST" ? held.promise : json({ projects: [] }));
    mount(); const form = await open(); fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect((within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close new Project form" }) as HTMLButtonElement).disabled).toBe(true);
    await act(() => held.resolve(json(receipt(body(posts()[0]![1])), 201)));
    await screen.findByText("Opened Project"); expect(posts()).toHaveLength(1);
  });

  it("releases only an explicit authoritative rejection and allows a corrected new intent", async () => {
    network.mockImplementation(async (_path, options) => options?.method === "POST"
      ? json({ error: "Creation was rejected" }, 409, { "x-project-mutation-disposition": "authoritative-rejection" })
      : json({ projects: [] }));
    mount(); const form = await open(); fireEvent.submit(form); await within(form).findByRole("alert");
    expect(sessionStorage.getItem(intentKey)).toBeNull();
    expect((within(form).getByLabelText("Project title") as HTMLInputElement).readOnly).toBe(false);
    fireEvent.change(within(form).getByLabelText("Project title"), { target: { value: "Corrected research title" } });
    fireEvent.submit(form); await waitFor(() => expect(posts()).toHaveLength(2));
    expect(body(posts()[1]![1]).id).not.toBe(body(posts()[0]![1]).id);
    expect(body(posts()[1]![1]).operationId).not.toBe(body(posts()[0]![1]).operationId);
    expect(body(posts()[1]![1]).title).toBe("Corrected research title");
    await within(form).findByRole("alert");
  });

  it("does not treat an unmarked conflict or mismatched successful response as an accepted receipt", async () => {
    let attempts = 0;
    network.mockImplementation(async (_path, options) => {
      if (options?.method !== "POST") return json({ projects: [] });
      const input = body(options); return ++attempts === 1 ? json({ error: "Unsettled conflict" }, 409)
        : json(receipt({ ...input, id: "different-project" }), 201);
    });
    const view = mount(), form = await open(); fireEvent.submit(form); await within(form).findByRole("alert");
    const retained = sessionStorage.getItem(intentKey);
    fireEvent.click(within(form).getByRole("button", { name: "Retry Project creation" }));
    await waitFor(() => expect(within(form).getByRole("alert").textContent).toContain("did not match"));
    expect(posts()).toHaveLength(2); expect(posts()[0]![1]?.body).toBe(posts()[1]![1]?.body);
    expect(sessionStorage.getItem(intentKey)).toBe(retained); expect(view.router.state.location.pathname).toBe("/projects");
  });

  it("retains an earlier unknown acceptance even if its later explicit retry is authoritatively rejected", async () => {
    let attempts = 0;
    network.mockImplementation(async (_path, options) => {
      if (options?.method !== "POST") return json({ projects: [] });
      return ++attempts === 1 ? json({ error: "First result unavailable" }, 503)
        : json({ error: "Current retry rejected" }, 409, { "x-project-mutation-disposition": "authoritative-rejection" });
    });
    mount(); const form = await open(); fireEvent.submit(form); await within(form).findByRole("alert");
    const retained = sessionStorage.getItem(intentKey);
    fireEvent.click(within(form).getByRole("button", { name: "Retry Project creation" }));
    await waitFor(() => expect(within(form).getByRole("alert").textContent).toContain("Current retry rejected"));
    expect(sessionStorage.getItem(intentKey)).toBe(retained); expect(posts()).toHaveLength(2);
    expect(posts()[0]![1]?.body).toBe(posts()[1]![1]?.body);
    expect((within(form).getByLabelText("Project title") as HTMLInputElement).readOnly).toBe(true);
  });

  it("sends no creation if its original intent cannot be retained before transport", async () => {
    mount(); const form = await open(); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    fireEvent.submit(form); expect((await within(form).findByRole("alert")).textContent).toContain("No request was sent");
    expect(posts()).toHaveLength(0); expect(sessionStorage.getItem(intentKey)).toBeNull();
    expect((within(form).getByLabelText("Project title") as HTMLInputElement).readOnly).toBe(false);
  });

  it("retains the old owner unknown input and requires an explicit current-identity refresh after server subject rejection", async () => {
    let attempts = 0, current = subject; const other = "b".repeat(64);
    network.mockImplementation(async (_path, options) => {
      if (options?.method !== "POST") return json({ projects: [] }, 200, { [PROJECT_CREATION_SUBJECT_HEADER]: current });
      if (++attempts === 1) return json({ error: "Original result unavailable" }, 503);
      current = other; return json({ error: "Sign-in identity changed. Refresh Projects before retrying." }, 409,
        { [PROJECT_CREATION_SUBJECT_RESULT_HEADER]: "mismatch" });
    });
    mount(); const form = await open("Old owner retained question"); fireEvent.submit(form); await within(form).findByRole("alert");
    const retained = sessionStorage.getItem(intentKey);
    fireEvent.click(within(form).getByRole("button", { name: "Retry Project creation" }));
    await waitFor(() => expect(within(form).getByRole("alert").textContent).toContain("Sign-in identity changed"));
    expect(sessionStorage.getItem(intentKey)).toBe(retained); expect(posts()).toHaveLength(2);
    expect((within(form).getByLabelText("Project title") as HTMLInputElement).value).toBe("");
    expect((within(form).getByRole("button", { name: "Create Project" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Projects" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "New Project" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("form", { name: "Create Project" })).toBeNull(); expect(posts()).toHaveLength(2);
    expect(sessionStorage.getItem(intentKey)).toBe(retained);
  });

  it("aborts a directory Retry on route exit and never publishes the old response into the next directory", async () => {
    const oldRead = deferred<Response>(); let reads = 0;
    network.mockImplementation(async () => ++reads === 1 ? json({ error: "Initial read unavailable" }, 503)
      : reads === 2 ? oldRead.promise : json({ projects: [] }));
    const view = mount(); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading Projects" }));
    const oldSignal = network.mock.calls[1]![1]?.signal; expect(oldSignal).toBeInstanceOf(AbortSignal);
    expect(oldSignal?.aborted).toBe(false);
    await act(() => view.router.navigate("/elsewhere")); expect(oldSignal?.aborted).toBe(true);
    await act(() => view.router.navigate("/projects")); await screen.findByText("No Projects yet");
    const stale = { ...receipt({ id: "obsolete-project", title: "Old request owner", operationId: "old-operation" }).project };
    await act(() => oldRead.resolve(json({ projects: [stale] })));
    expect(screen.queryByText("Old request owner")).toBeNull(); expect(screen.getByText("No Projects yet")).toBeTruthy();
    expect(posts()).toHaveLength(0); expect(network).toHaveBeenCalledTimes(3);
  });

  it("scopes retained input to the authenticated directory subject and fences an old receipt after actual client logout and identity delivery", async () => {
    vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1");
    const first = "local_11111111-1111-4111-8111-111111111111", second = "local_22222222-2222-4222-8222-222222222222";
    const otherSubject = "b".repeat(64), held = deferred<Response>(), otherHeld = deferred<Response>(); let actor = first, otherPosts = 0;
    const session = () => json({ principal: { id: actor, actor: `local-account:${actor}`,
      capabilities: { systemAdministrator: false, fileEvidenceOperator: false } }, csrf: (actor === first ? "a" : "b").repeat(43) });
    network.mockImplementation(async (path, options) => {
      if (String(path) === "/api/auth/session") return session();
      if (String(path) === "/api/auth/logout") return new Response(null, { status: 204 });
      if (String(path) === "/api/auth/login") { actor = second; return session(); }
      if (options?.method === "POST") {
        if (new Headers(options.headers).get(PROJECT_CREATION_SUBJECT_HEADER) === subject) return held.promise;
        return ++otherPosts === 1 ? otherHeld.promise : json(receipt(body(options), true));
      }
      return json({ projects: [] }, 200, { [PROJECT_CREATION_SUBJECT_HEADER]: actor === first ? subject : otherSubject });
    });
    await readAuthentication(); const view = mount(), form = await open("First account research"); fireEvent.submit(form);
    await waitFor(() => expect(posts().filter(([path]) => String(path) === "/api/projects")).toHaveLength(1));
    const original = posts().find(([path]) => String(path) === "/api/projects")!;
    expect(new Headers(original[1]?.headers).get(PROJECT_CREATION_SUBJECT_HEADER)).toBe(subject);
    expect(new Headers(original[1]?.headers).get("x-sfw-csrf")).toBe("a".repeat(43));
    const retained = sessionStorage.getItem(intentKey); expect(retained).not.toBeNull();
    await act(() => signOut()); expect(screen.queryByRole("form", { name: "Create Project" })).toBeNull();
    await act(() => signIn("second-account", "Synthetic second account password"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Projects" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "New Project" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("First account research")).toBeNull();
    expect(sessionStorage.getItem(intentKey)).toBe(retained);
    expect(sessionStorage.getItem(`project-directory-create-intent:${otherSubject}`)).toBeNull();
    const secondForm = await open("Second account research"); fireEvent.submit(secondForm);
    await waitFor(() => expect(posts().filter(([path]) => String(path) === "/api/projects")).toHaveLength(2));
    const secondInput = posts().filter(([path]) => String(path) === "/api/projects")[1]!;
    expect(new Headers(secondInput[1]?.headers).get("x-sfw-csrf")).toBe("b".repeat(43));
    const secondRetained = sessionStorage.getItem(`project-directory-create-intent:${otherSubject}`); expect(secondRetained).not.toBeNull();
    await act(() => held.resolve(json(receipt(body(original[1])), 201)));
    expect(view.router.state.location.pathname).toBe("/projects"); expect(screen.queryByText("Opened Project")).toBeNull();
    expect(sessionStorage.getItem(`project-directory-create-intent:${otherSubject}`)).toBe(secondRetained);
    expect((within(secondForm).getByLabelText("Project title") as HTMLInputElement).value).toBe("Second account research");
    expect((within(secondForm).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await act(() => otherHeld.resolve(json({ error: "Second result unavailable" }, 503))); await within(secondForm).findByRole("alert");
    fireEvent.click(within(secondForm).getByRole("button", { name: "Retry Project creation" })); await screen.findByText("Opened Project");
    const projectPosts = posts().filter(([path]) => String(path) === "/api/projects"); expect(projectPosts).toHaveLength(3);
    expect(projectPosts[2]![1]?.body).toBe(secondInput[1]?.body);
    expect(view.router.state.location.pathname).toBe(`/projects/${body(secondInput[1]).id}`);
  });
});
