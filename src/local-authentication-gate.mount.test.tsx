import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAuthenticationGate, LocalSessionAction } from "./components/LocalAuthenticationGate";
import { applicationFetch, readAuthentication } from "./lib/authentication-client";

// Mounted component behavior only, with controlled delivery. A real browser
// and genuine native HTTP/session stack must qualify cookie/admission behavior.
const principalId = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae";
const delivered = { principal: { id: principalId, actor: `local-account:${principalId}`,
  capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf: "A".repeat(43) };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function CurrentUrl() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}{location.search}{location.hash}</output>;
}
function BusinessPage() {
  const [message, setMessage] = useState("Business page mounted");
  useEffect(() => { void applicationFetch("/api/samples").then(() => setMessage("Business page loaded")); }, []);
  return <section><p>{message}</p><button type="button" onClick={() => {
    void applicationFetch("/api/samples", { method: "PATCH", body: "one-change" });
  }}>Change record</button></section>;
}
const retainedUrl = "/projects/project.one?tab=map#item";
function mount() {
  return render(<MemoryRouter initialEntries={[retainedUrl]}>
    <CurrentUrl /><header><LocalSessionAction /></header>
    <main><LocalAuthenticationGate><BusinessPage /></LocalAuthenticationGate></main>
  </MemoryRouter>);
}
function fillAndSubmit(password = "normal-r0-password") {
  fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "operator" } });
  const field = screen.getByLabelText("Password");
  fireEvent.change(field, { target: { value: password } });
  fireEvent.submit(field.closest("form")!);
}

describe("local authentication route gate", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1");
    // Reset the shared module through its public explicit status-check path.
    // Do not reload React modules or add a product-only reset hook.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 })); await readAuthentication(); fetchMock.mockReset();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("mounts Cloudflare content immediately without probing auth or changing fetch arguments", async () => {
    vi.stubEnv("VITE_LOCAL_AUTHENTICATION", ""); fetchMock.mockResolvedValue(new Response("original"));
    mount(); await screen.findByText("Business page loaded");
    expect(fetchMock.mock.calls).toEqual([["/api/samples"]]);
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByLabelText("Current route").textContent).toBe(retainedUrl);
  });

  it("holds route children until explicit login succeeds and keeps the exact URL", async () => {
    const session = pending<Response>();
    fetchMock.mockReturnValueOnce(session.promise).mockResolvedValueOnce(json(delivered)).mockResolvedValueOnce(json({ samples: [] }));
    mount(); expect(screen.getByText("Checking sign-in status…")).toBeTruthy();
    expect(screen.queryByText("Business page mounted")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
    session.resolve(new Response(null, { status: 401 })); await screen.findByRole("heading", { name: "Sign in" });
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("Password") as HTMLInputElement).autocomplete).toBe("current-password");
    fillAndSubmit(); await screen.findByText("Business page loaded");
    expect(screen.getByRole("button", { name: "Sign out" }).closest("header")).toBeTruthy();
    expect(screen.getByText("Business page loaded").closest("section")?.parentElement?.tagName).toBe("MAIN");
    expect(screen.getByLabelText("Current route").textContent).toBe(retainedUrl);
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(["/api/auth/session", "/api/auth/login", "/api/samples"]);
  });

  it("clears the password after denial and avoids repeating login after an unknown response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(new Error("login delivery unknown")).mockResolvedValueOnce(json(delivered)).mockResolvedValueOnce(json({ samples: [] }));
    mount(); await screen.findByRole("heading", { name: "Sign in" }); fillAndSubmit();
    expect((await screen.findByRole("alert")).textContent).toContain("Sign-in failed");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    fillAndSubmit(); await screen.findByRole("button", { name: "Check session" });
    expect(screen.queryByText("Business page mounted")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check session" })); await screen.findByText("Business page loaded");
    expect(fetchMock.mock.calls.filter(([input]) => input === "/api/auth/login")).toHaveLength(2);
    expect(screen.getByLabelText("Current route").textContent).toBe(retainedUrl);
  });

  it("hides route children on a current business 401 without replaying the mutation", async () => {
    fetchMock.mockResolvedValueOnce(json(delivered)).mockResolvedValueOnce(json({ samples: [] }))
      .mockResolvedValueOnce(json({ error: "Authentication is required." }, 401));
    mount(); await screen.findByText("Business page loaded");
    fireEvent.click(screen.getByRole("button", { name: "Change record" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.queryByText("Business page loaded")).toBeNull();
    expect((screen.getByRole("alert")).textContent).toContain("Your session ended");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(screen.getByLabelText("Current route").textContent).toBe(retainedUrl);
  });

  it("keeps an unknown logout behind explicit session checking and never replays it", async () => {
    fetchMock.mockResolvedValueOnce(json(delivered)).mockResolvedValueOnce(json({ samples: [] }))
      .mockRejectedValueOnce(new Error("logout delivery unknown")).mockResolvedValueOnce(new Response(null, { status: 401 }));
    mount(); await screen.findByText("Business page loaded");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" })); await screen.findByRole("button", { name: "Check session" });
    expect(screen.queryByText("Business page loaded")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Check session" })); await screen.findByRole("heading", { name: "Sign in" });
    expect(fetchMock.mock.calls.filter(([input]) => input === "/api/auth/logout")).toHaveLength(1);
    expect(screen.getByLabelText("Current route").textContent).toBe(retainedUrl);
  });
});
