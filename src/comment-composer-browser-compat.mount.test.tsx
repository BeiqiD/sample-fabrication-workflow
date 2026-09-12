import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommentComposer } from "./components/CommentComposer";
import { api } from "./lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("submits and finalizes a math note when the browser lacks randomUUID", async () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({
    provider: null, available: false, authentication: "not_configured", message: "No file storage",
  });
  const create = vi.spyOn(api, "createCommentSubmission").mockResolvedValue({ id: "created", deduplicated: false });
  const finalize = vi.spyOn(api, "finalizeCommentSubmission").mockResolvedValue({ ok: true, status: "ready" });
  const refresh = vi.fn().mockResolvedValue(undefined);
  const context = { kind: "sample" as const, sampleId: "sample-a", expectedUpdatedAt: "2026-09-11T00:00:00Z" };
  render(<CommentComposer label="Math note" context={context} onSubmitted={refresh} submitLabel="Add note" />);
  const body = String.raw`Measured $\frac{1}{1+x}$`;
  fireEvent.change(screen.getByRole("textbox", { name: "Math note" }), { target: { value: body } });
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledWith({
    id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
    body, context, items: [],
  });
  expect(finalize).toHaveBeenCalledWith(create.mock.calls[0][0].id);
  expect((screen.getByRole("textbox", { name: "Math note" }) as HTMLTextAreaElement).value).toBe("");
});
