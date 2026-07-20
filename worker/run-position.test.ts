import { describe, expect, it } from "vitest";
import { insertionPosition } from "./run-position";

const steps = [{ id: "a", position: 1000 }, { id: "b", position: 2000 }];

describe("sample run insertion positions", () => {
  it("leaves room at the beginning", () => expect(insertionPosition(steps)).toBe(0));
  it("inserts between existing steps", () => expect(insertionPosition(steps, "a")).toBe(1500));
  it("leaves room at the end", () => expect(insertionPosition(steps, "b")).toBe(3000));
  it("rejects an unknown insertion point", () => expect(insertionPosition(steps, "missing")).toBeNull());
});
