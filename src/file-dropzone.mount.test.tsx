import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDropzone } from "./components/FileDropzone";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("upload picker command ownership", () => {
  it.each(["Enter", " "])("leaves %s on Remove to the child button without opening a picker", (key) => {
    const browse = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const onFile = vi.fn();
    render(<FileDropzone accept="text/csv" file={new File(["value"], "measurement.csv", { type: "text/csv" })}
      label="Choose file" onFile={onFile} />);
    const remove = screen.getByRole("button", { name: "Remove" });
    remove.focus();
    fireEvent.keyDown(remove, { key });
    expect(browse).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(onFile).toHaveBeenCalledExactlyOnceWith(null);
    expect(browse).not.toHaveBeenCalled();
  });

  it("keeps Enter/Space browsing on the picker and disables all controls together", () => {
    const browse = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const onFile = vi.fn();
    const { rerender } = render(<FileDropzone accept="text/csv" file={null} label="Choose file" onFile={onFile} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Choose file" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Choose file" }), { key: " " });
    expect(browse).toHaveBeenCalledTimes(2);
    rerender(<FileDropzone accept="text/csv" file={new File(["value"], "measurement.csv", { type: "text/csv" })}
      label="Choose file" disabled onFile={onFile} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Replace measurement.csv" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(browse).toHaveBeenCalledTimes(2);
    expect(onFile).not.toHaveBeenCalled();
  });
});
