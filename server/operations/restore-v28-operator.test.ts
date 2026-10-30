import { describe, expect, it } from "vitest";
import { executeOfflineV28Restore, parseOfflineV28RestoreCommand, OfflineV28RestoreError } from "./restore-v28-operator";

const args = ["restore", "--archive", "/private/archive.zip", "--destination", "/private/new-target", "--sha256", "a".repeat(64)];
describe("fixed offline V28 command selection", () => {
  it("issues one frozen fixed V5 restore token with an explicit immutable root UID", () => {
    const command = parseOfflineV28RestoreCommand([...args, "--filesystem-root-owner-uid", "65534"]);
    expect(command).toEqual({ kind: "fixed-offline-v28-restore/1" }); expect(Object.isFrozen(command)).toBe(true);
  });
  it("rejects historical, catalog and executable overrides rather than selecting a fallback", () => {
    for (const input of [["upgrade", ...args.slice(1)], [...args, "--catalog", "v28"], [...args, "--entry", "server/main.ts"]])
      expect(() => parseOfflineV28RestoreCommand(input)).toThrow(OfflineV28RestoreError);
  });
  it("rejects missing, repeated and ambiguous fields", () => {
    for (const input of [args.slice(0, -2), [...args, "--archive", "/other.zip"], [...args, "--sha256", "b".repeat(64)]])
      expect(() => parseOfflineV28RestoreCommand(input)).toThrow(OfflineV28RestoreError);
  });
  it("rejects relative paths, path aliases and source-destination identity", () => {
    for (const input of [[...args.slice(0, 2), "relative.zip", ...args.slice(3)],
      [...args.slice(0, 4), "/private/../target", ...args.slice(5)], [...args.slice(0, 4), "/private/archive.zip", ...args.slice(5)]])
      expect(() => parseOfflineV28RestoreCommand(input)).toThrow(OfflineV28RestoreError);
  });
  it("rejects noncanonical hashes and root UID values", () => {
    for (const input of [[...args.slice(0, -1), "A".repeat(64)], [...args.slice(0, -1), "a".repeat(63)],
      [...args, "--filesystem-root-owner-uid", "00"], [...args, "--filesystem-root-owner-uid", "4294967296"]])
      expect(() => parseOfflineV28RestoreCommand(input)).toThrow(OfflineV28RestoreError);
  });
  it("rejects copied or fabricated command objects before any archive or target I/O", async () => {
    const command = parseOfflineV28RestoreCommand(args);
    await expect(executeOfflineV28Restore({ ...command })).rejects.toThrow(OfflineV28RestoreError);
    await expect(executeOfflineV28Restore(Object.freeze({ kind: "fixed-offline-v28-restore/1" }))).rejects.toThrow(OfflineV28RestoreError);
  });
});
