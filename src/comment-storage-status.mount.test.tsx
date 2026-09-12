import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedStorageStatus } from "../shared/types";
import { CommentComposer } from "./components/CommentComposer";
import { api } from "./lib/api";

const ready: ManagedStorageStatus = {
  provider: "switchdrive", available: true, authentication: "service_binding", message: "File storage ready",
};

function deferredStatus() {
  let resolve!: (status: ManagedStorageStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ManagedStorageStatus>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function composer(sampleId: string) {
  return <CommentComposer
    label={`Comment on ${sampleId}`}
    context={{ kind: "sample", sampleId, expectedUpdatedAt: "2026-09-12T00:00:00Z" }}
    onSubmitted={async () => undefined}
  />;
}

function attachmentInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("rechecks storage after a failed request when another Composer is opened", async () => {
  const status = vi.spyOn(api, "getManagedStorageStatus")
    .mockRejectedValueOnce(new Error("Temporary network failure"))
    .mockResolvedValue(ready);
  const first = render(composer("sample-a"));
  fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  await screen.findByText(/File storage status could not be loaded/);
  expect(attachmentInput(first.container).disabled).toBe(true);
  expect((screen.getByRole("menuitem", { name: "Add attachment link" }) as HTMLButtonElement).disabled).toBe(false);
  first.unmount();

  const second = render(composer("sample-b"));
  await waitFor(() => expect(attachmentInput(second.container).disabled).toBe(false));
  expect(status).toHaveBeenCalledTimes(2);
});

it("lets an open Composer retry explicitly without clearing its draft or retrying automatically", async () => {
  const retry = deferredStatus();
  const status = vi.spyOn(api, "getManagedStorageStatus")
    .mockRejectedValueOnce(new Error("Temporary network failure"))
    .mockReturnValueOnce(retry.promise)
    .mockResolvedValue(ready);
  const view = render(composer("sample-a"));
  const textarea = screen.getByRole("textbox", { name: "Comment on sample-a" }) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "Keep this observation" } });
  fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  await screen.findByText(/File storage status could not be loaded/);
  await act(async () => undefined);
  expect(status).toHaveBeenCalledTimes(1);

  const retryButton = screen.getByRole("menuitem", { name: "Retry storage connection" }) as HTMLButtonElement;
  fireEvent.click(retryButton);
  expect(retryButton.disabled).toBe(true);
  expect(screen.getByText("Checking file storage connection…")).toBeTruthy();
  fireEvent.click(retryButton);
  expect(status).toHaveBeenCalledTimes(2);
  await act(async () => retry.reject(new Error("Still offline")));
  expect(retryButton.disabled).toBe(false);
  expect(attachmentInput(view.container).disabled).toBe(true);
  await act(async () => undefined);
  expect(status).toHaveBeenCalledTimes(2);

  fireEvent.click(retryButton);
  await waitFor(() => expect(attachmentInput(view.container).disabled).toBe(false));
  expect(status).toHaveBeenCalledTimes(3);
  expect(textarea.value).toBe("Keep this observation");
  expect(screen.queryByRole("menuitem", { name: "Retry storage connection" })).toBeNull();
});

it("shares an in-flight status check and keeps it alive for the remaining Composer after unmount", async () => {
  const pending = deferredStatus();
  const status = vi.spyOn(api, "getManagedStorageStatus").mockReturnValue(pending.promise);
  const first = render(composer("sample-a"));
  const second = render(composer("sample-b"));
  expect(status).toHaveBeenCalledOnce();
  expect(attachmentInput(second.container).disabled).toBe(true);
  first.unmount();

  await act(async () => pending.resolve(ready));
  expect(attachmentInput(second.container).disabled).toBe(false);
  expect(status).toHaveBeenCalledOnce();
});

it("checks storage once for a TIFF batch during an unresolved lookup and retains every rejected file on failure", async () => {
  const pending = deferredStatus();
  const status = vi.spyOn(api, "getManagedStorageStatus").mockReturnValue(pending.promise);
  const view = render(composer("sample-a"));
  const images = view.container.querySelector<HTMLInputElement>('input[type="file"][accept]')!;
  fireEvent.change(images, { target: { files: [
    new File(["first"], "first.tiff", { type: "image/tiff" }),
    new File(["second"], "second.tiff", { type: "image/tiff" }),
  ] } });
  expect(status).toHaveBeenCalledOnce();

  await act(async () => pending.reject(new Error("Offline")));
  expect(screen.getByText("first.tiff")).toBeTruthy();
  expect(screen.getByText("second.tiff")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Add as attachment" })
    .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  expect(status).toHaveBeenCalledOnce();
});

it("preserves a configured-unavailable response and can refresh it after storage is enabled", async () => {
  const status = vi.spyOn(api, "getManagedStorageStatus")
    .mockResolvedValueOnce({
      provider: null, available: false, authentication: "not_configured", message: "File storage has not been configured.",
    })
    .mockResolvedValue(ready);
  const view = render(composer("sample-a"));
  fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  await screen.findByText("File storage has not been configured.");
  expect(screen.queryByText(/File storage status could not be loaded/)).toBeNull();
  expect(attachmentInput(view.container).disabled).toBe(true);
  expect(status).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("menuitem", { name: "Retry storage connection" }));
  await waitFor(() => expect(attachmentInput(view.container).disabled).toBe(false));
  expect(status).toHaveBeenCalledTimes(2);
});
