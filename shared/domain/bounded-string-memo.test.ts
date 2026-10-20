import { describe, expect, it, vi } from "vitest";
import { boundedStringMemo } from "./bounded-string-memo";

describe("bounded immutable string derivation", () => {
  it("keys only exact strings even when two derivations have the same value", () => {
    const derive = vi.fn((input: string) => input.trim());
    const memo = boundedStringMemo(derive, { maxEntries: 2, maxStringBytes: 100 });
    expect(memo(" sql ")).toBe("sql"); expect(memo(" sql ")).toBe("sql");
    expect(memo("sql")).toBe("sql"); expect(memo("sql")).toBe("sql");
    expect(derive.mock.calls).toEqual([[" sql "], ["sql"]]);
  });

  it("keeps recently used entries and recomputes an evicted exact input", () => {
    const derive = vi.fn((input: string) => input.toUpperCase());
    const memo = boundedStringMemo(derive, { maxEntries: 2, maxStringBytes: 100 });
    for (const input of ["a", "b", "a", "c", "a", "b"]) expect(memo(input)).toBe(input.toUpperCase());
    expect(derive.mock.calls).toEqual([["a"], ["b"], ["c"], ["b"]]);
  });

  it("bounds the combined key and result UTF-16 bytes at the inclusive limit", () => {
    const derive = vi.fn((input: string) => input);
    const memo = boundedStringMemo(derive, { maxEntries: 20, maxStringBytes: 12 });
    for (const input of ["a", "bb", "a", "bb", "c", "bb", "a"]) expect(memo(input)).toBe(input);
    expect(derive.mock.calls).toEqual([["a"], ["bb"], ["c"], ["a"]]);
    const unicode = vi.fn((input: string) => input);
    const unicodeMemo = boundedStringMemo(unicode, { maxEntries: 20, maxStringBytes: 8 });
    for (const input of ["😀", "😀", "a", "😀"]) expect(unicodeMemo(input)).toBe(input);
    expect(unicode.mock.calls).toEqual([["😀"], ["a"], ["😀"]]);
  });

  it("bypasses oversized inputs and results without displacing retained small strings", () => {
    const derive = vi.fn((input: string) => input === "x" ? "oversized result" : input);
    const memo = boundedStringMemo(derive, { maxEntries: 2, maxStringBytes: 8 });
    for (const input of ["a", "abcd", "abcd", "x", "x", "a"]) memo(input);
    expect(derive.mock.calls).toEqual([["a"], ["abcd"], ["abcd"], ["x"], ["x"]]);
  });

  it("retries failed derivations and retains only a later successful string", () => {
    let calls = 0;
    const memo = boundedStringMemo(() => { if (++calls < 3) throw new Error("invalid SQL"); return "valid"; },
      { maxEntries: 1, maxStringBytes: 100 });
    expect(() => memo("same input")).toThrow("invalid SQL"); expect(() => memo("same input")).toThrow("invalid SQL");
    expect(memo("same input")).toBe("valid"); expect(memo("same input")).toBe("valid"); expect(calls).toBe(3);
  });

  it("captures finite limits instead of accepting later configuration mutation", () => {
    const limits = { maxEntries: 1, maxStringBytes: 8 }, derive = vi.fn((input: string) => input);
    const memo = boundedStringMemo(derive, limits); limits.maxEntries = 100; limits.maxStringBytes = 1000;
    for (const input of ["a", "b", "a"]) memo(input);
    expect(derive.mock.calls).toEqual([["a"], ["b"], ["a"]]);
    expect(() => boundedStringMemo(derive, { maxEntries: Infinity, maxStringBytes: 8 })).toThrow("Invalid string memo limits");
    expect(() => boundedStringMemo(derive, { maxEntries: 1, maxStringBytes: NaN })).toThrow("Invalid string memo limits");
  });
});
