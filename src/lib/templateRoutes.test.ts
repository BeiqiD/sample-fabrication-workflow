import { describe, expect, it } from "vitest";
import { templateDetailPath } from "./templateRoutes";

describe("template detail routes", () => {
  it("keeps process and metrology templates on their canonical detail pages", () => {
    expect(templateDetailPath("process-1", "process")).toBe("/templates/process-1");
    expect(templateDetailPath("metrology-1", "metrology")).toBe("/templates/metrology/metrology-1");
  });

  it("encodes template identifiers before placing them in a route", () => {
    expect(templateDetailPath("template / 1", "metrology")).toBe("/templates/metrology/template%20%2F%201");
  });
});
