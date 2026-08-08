// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type TemplateDetail } from "./lib/api";
import { MetrologyTemplatePage } from "./pages/MetrologyTemplatePage";
import { TemplatePage } from "./pages/TemplatePage";

const timestamp = "2026-08-08T12:00:00.000Z";

function template(kind: "process" | "metrology"): TemplateDetail {
  return {
    id: `${kind}-template`,
    recipeFamilyId: `${kind}-family`,
    name: kind === "process" ? "Process template" : "Metrology template",
    templateType: kind === "process" ? "process" : "module",
    templateKind: kind,
    version: 1,
    manifestHash: `${kind}-manifest`,
    sourceFilename: null,
    toolName: kind === "metrology" ? "SEM" : null,
    parametersText: null,
    commentsText: null,
    initialStateHash: null,
    initialStateImageKeys: [],
    initialSubstrateStep: null,
    locked: false,
    lockedAt: null,
    createdAt: timestamp,
    archived: false,
    metrologyNotes: kind === "metrology" ? "Server notes" : null,
    referenceAttachments: [],
    steps: kind === "metrology" ? [{
      id: "metrology-step",
      logicalStepKey: "metrology-step",
      definitionHash: "definition",
      expectedStateHash: null,
      position: 0,
      sourceRow: null,
      stepNumber: null,
      sectionName: null,
      name: "SEM",
      toolName: "SEM",
      parametersText: null,
      commentsText: null,
      imageKeys: [],
    }] : [],
  };
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Template focus history", () => {
  it("does not refetch or discard unsaved metrology notes when only focus history changes", async () => {
    const getTemplate = vi.spyOn(api, "getTemplate").mockResolvedValue({
      template: template("metrology"),
    });
    const router = createMemoryRouter([{
      path: "/templates/metrology/:templateId",
      element: <MetrologyTemplatePage />,
    }], { initialEntries: ["/templates/metrology/metrology-template"] });
    render(<RouterProvider router={router} />);

    const notes = await screen.findByRole("textbox", { name: "Reference notes" });
    fireEvent.change(notes, { target: { value: "Unsaved local notes" } });
    await act(async () => {
      await router.navigate("/templates/metrology/metrology-template?focus=metrology_reference%3Ar1_AAAA");
    });
    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "Reference notes" }) as HTMLTextAreaElement).value)
        .toBe("Unsaved local notes");
    });
    expect(getTemplate).toHaveBeenCalledTimes(1);

    await act(async () => { await router.navigate(-1); });
    await act(async () => { await router.navigate(1); });
    expect(getTemplate).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "Reference notes" }) as HTMLTextAreaElement).value)
      .toBe("Unsaved local notes");
    router.dispose();
  });

  it("does not reload a process template when Back or Forward changes only focus", async () => {
    const getTemplate = vi.spyOn(api, "getTemplate").mockResolvedValue({
      template: template("process"),
    });
    const router = createMemoryRouter([{
      path: "/templates/:templateId",
      element: <TemplatePage />,
    }], { initialEntries: ["/templates/process-template"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: "Process template" });
    expect(getTemplate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await router.navigate("/templates/process-template?focus=recipe_revision%3Ar1_AAAA");
    });
    await act(async () => { await router.navigate(-1); });
    await act(async () => { await router.navigate(1); });
    expect(getTemplate).toHaveBeenCalledTimes(1);
    router.dispose();
  });
});
