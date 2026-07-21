import { describe, expect, it } from "vitest";
import { titleChangeAudit } from "./sample-update";

describe("sample update audit", () => {
  it("does not add an API event when the title is unchanged", () => {
    expect(titleChangeAudit("Etch test", "Etch test")).toBeNull();
  });

  it("records only the title field handled outside database triggers", () => {
    expect(titleChangeAudit("Etch test", "Etch calibration")).toEqual({
      body: "Title changed from Etch test to Etch calibration",
      metadata: {
        action: "sample_details_updated",
        changes: { title: { from: "Etch test", to: "Etch calibration" } },
      },
    });
  });

  it("preserves punctuation and Unicode in the audit text", () => {
    expect(titleChangeAudit("片 A", "片 A · diced")?.body).toBe("Title changed from 片 A to 片 A · diced");
  });
});
