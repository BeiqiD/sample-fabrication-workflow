import { describe, expect, it } from "vitest";
import { chunkRows } from "./d1-bulk";

describe("D1 bulk inserts", () => {
  it("keeps every statement within D1's 100 parameter limit", () => {
    const rows = Array.from({ length: 34 }, (_, index) => Array(11).fill(index));
    const chunks = chunkRows(rows, 11);
    expect(chunks.map((chunk) => chunk.length)).toEqual([9, 9, 9, 7]);
    expect(chunks.every((chunk) => chunk.length * 11 <= 100)).toBe(true);
  });
});
