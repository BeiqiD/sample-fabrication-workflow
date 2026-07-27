import { describe, expect, it } from "vitest";
import {
  activeSampleDirectorySettingCount,
  applySampleDirectorySettings,
  clearSampleDirectorySetting,
  sampleDirectorySettings,
} from "./sample-directory";

describe("sample directory URL state", () => {
  it("combines search, filters, sorting, and pagination without losing the search", () => {
    const current = new URLSearchParams("q=InP&page=3");
    const next = applySampleDirectorySettings(current, {
      status: "active",
      location: "Box A",
      parent: "7449",
      workflow: "Bonding",
      sort: "created-desc",
    });

    expect(next.get("q")).toBe("InP");
    expect(next.get("status")).toBe("active");
    expect(next.get("location")).toBe("Box A");
    expect(next.get("parent")).toBe("7449");
    expect(next.get("process")).toBe("Bonding");
    expect(next.get("sort")).toBe("created-desc");
    expect(next.has("page")).toBe(false);
    expect(activeSampleDirectorySettingCount(next)).toBe(5);
  });

  it("uses contextual defaults without storing redundant sort state", () => {
    const searched = applySampleDirectorySettings(new URLSearchParams("q=InP"), {
      status: "",
      location: "",
      parent: "",
      workflow: "",
      sort: "relevance",
    });
    const unsearched = applySampleDirectorySettings(new URLSearchParams(), {
      status: "",
      location: "",
      parent: "",
      workflow: "",
      sort: "active-updated-desc",
    });

    expect(searched.has("sort")).toBe(false);
    expect(unsearched.has("sort")).toBe(false);
    expect(sampleDirectorySettings(searched).sort).toBe("relevance");
    expect(sampleDirectorySettings(unsearched).sort).toBe("active-updated-desc");
  });

  it("removes one active setting and resets pagination", () => {
    const next = clearSampleDirectorySetting(
      new URLSearchParams("q=InP&status=active&sort=created-desc&page=2"),
      "status",
    );

    expect(next.get("q")).toBe("InP");
    expect(next.has("status")).toBe(false);
    expect(next.get("sort")).toBe("created-desc");
    expect(next.has("page")).toBe(false);
  });
});
