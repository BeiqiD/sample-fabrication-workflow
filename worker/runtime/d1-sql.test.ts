import { describe, expect, it, vi } from "vitest";
import { d1ReadinessDatabase } from "./d1-sql";

describe("native D1 readiness adapter", () => {
  it("preserves database and prepared-first receivers without opening a session or adding mutation metadata", async () => {
    const row = { ok: 1 };
    const statement = { first: vi.fn(async function(this: unknown) { expect(this).toBe(statement); return row; }) };
    const database = { prepare: vi.fn(function(this: unknown, sql: string) {
      expect(this).toBe(database); expect(sql).toBe("SELECT 1 AS ok"); return statement;
    }), withSession: vi.fn(() => { throw new Error("Readiness must retain ordinary reads"); }) };
    const result = await d1ReadinessDatabase(database as unknown as D1Database).prepare("SELECT 1 AS ok").first();
    expect(result).toBe(row); expect(database.prepare).toHaveBeenCalledTimes(1);
    expect(statement.first).toHaveBeenCalledTimes(1); expect(database.withSession).not.toHaveBeenCalled();
  });

  it("propagates the exact native prepare error", () => {
    const error = new Error("Native prepare failed");
    const database = { prepare: () => { throw error; } } as unknown as D1Database;
    let thrown: unknown;
    try { d1ReadinessDatabase(database).prepare("SELECT 1 AS ok"); } catch (caught) { thrown = caught; }
    expect(thrown).toBe(error);
  });

  it("propagates the exact native first rejection", async () => {
    const error = new Error("Native first failed");
    const database = { prepare: () => ({ first: async () => { throw error; } }) } as unknown as D1Database;
    await expect(d1ReadinessDatabase(database).prepare("SELECT 1 AS ok").first()).rejects.toBe(error);
  });

  it("retains successful null results", async () => {
    const database = { prepare: () => ({ first: async () => null }) } as unknown as D1Database;
    expect(await d1ReadinessDatabase(database).prepare("SELECT 1 AS ok").first()).toBeNull();
  });

  it("prepares afresh on the current native database for every readiness call", async () => {
    const values = [{ ok: "first" }, { ok: "second" }];
    const prepare = vi.fn(() => ({ first: async () => values.shift() }));
    const adapter = d1ReadinessDatabase({ prepare } as unknown as D1Database);
    expect(await adapter.prepare("SELECT 1 AS ok").first()).toEqual({ ok: "first" });
    expect(await adapter.prepare("SELECT 1 AS ok").first()).toEqual({ ok: "second" });
    expect(prepare.mock.calls).toHaveLength(2);
  });
});
