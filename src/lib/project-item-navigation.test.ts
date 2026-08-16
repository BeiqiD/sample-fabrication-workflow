import { describe, expect, it } from "vitest";
import {
  isProjectItemFocusId,
  projectItemFocusAbsoluteUrl,
  projectItemFocusPath,
  projectItemFocusRequest,
} from "./project-item-navigation";

describe("Project occurrence focus navigation", () => {
  it("distinguishes absent, valid, and malformed focus requests", () => {
    expect(projectItemFocusRequest("")).toEqual({ status: "none", itemId: null });
    expect(projectItemFocusRequest("?focus=item-note")).toEqual({
      status: "valid",
      itemId: "item-note",
    });
    expect(projectItemFocusRequest("?focus=..")).toEqual({
      status: "valid",
      itemId: "..",
    });
    expect(projectItemFocusRequest("?focus=item%2F..%2F%E6%B8%AC")).toEqual({
      status: "valid",
      itemId: "item/../測",
    });
    expect(projectItemFocusRequest("?focus=a&focus=a")).toEqual({
      status: "invalid",
      itemId: null,
    });
    expect(projectItemFocusRequest("?focus=")).toEqual({
      status: "invalid",
      itemId: null,
    });
    expect(projectItemFocusRequest("?focus=%20item")).toEqual({
      status: "invalid",
      itemId: null,
    });
    expect(projectItemFocusRequest("?focus=item%00x")).toEqual({
      status: "invalid",
      itemId: null,
    });
    expect(projectItemFocusRequest(`?focus=${"x".repeat(257)}`)).toEqual({
      status: "invalid",
      itemId: null,
    });
  });

  it("keeps path-like and Unicode identities inside one encoded query value", () => {
    expect(isProjectItemFocusId("item with internal spaces")).toBe(true);
    expect(projectItemFocusPath("/projects/project-a", "item/../測")).toBe(
      "/projects/project-a?focus=item%2F..%2F%E6%B8%AC",
    );
    expect(projectItemFocusAbsoluteUrl(
      "https://samples.run",
      "/projects/project-a",
      "item-note",
    )).toBe("https://samples.run/projects/project-a?focus=item-note");
  });

  it("refuses to generate a stable link from an invalid identity", () => {
    expect(() => projectItemFocusPath("/projects/project-a", " item ")).toThrow(TypeError);
    expect(() => projectItemFocusPath("/projects/project-a", "item\nnext")).toThrow(TypeError);
  });
});
