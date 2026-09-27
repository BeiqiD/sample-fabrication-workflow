import assert from "node:assert/strict";
import { test } from "node:test";
import { createSqlSplitCache } from "./lib/test-sql-split-cache.mjs";

test("identical SQL text is parsed once and reuses its immutable statements", () => {
  const calls = [];
  const split = createSqlSplitCache((sql) => { calls.push(sql); return [sql]; });
  const first = split("SELECT 1;");
  assert.equal(split(["SELECT", "1;"].join(" ")), first);
  assert.deepEqual(calls, ["SELECT 1;"]);
});

test("every SQL text change receives its own parse without normalization", () => {
  const calls = [];
  const split = createSqlSplitCache((sql) => { calls.push(sql); return [sql]; });
  const original = split("SELECT 1;");
  for (const sql of ["SELECT 2;", "SELECT 1; ", "SELECT 1; -- fixture"]) {
    const changed = split(sql);
    assert.notEqual(changed, original);
    assert.deepEqual(changed, [sql]);
  }
  assert.deepEqual(calls, ["SELECT 1;", "SELECT 2;", "SELECT 1; ", "SELECT 1; -- fixture"]);
});

test("cached statements cannot be mutated by either the caller or the parser", () => {
  const parserResult = ["SELECT 1;"];
  const split = createSqlSplitCache(() => parserResult);
  const statements = split("fixture");
  assert(Object.isFrozen(statements));
  assert.throws(() => { statements[0] = "SELECT 2;"; }, TypeError);
  assert.throws(() => statements.push("SELECT 3;"), TypeError);
  parserResult[0] = "SELECT 4;";
  parserResult.push("SELECT 5;");
  assert.deepEqual(split("fixture"), ["SELECT 1;"]);
});

test("a parser error is not cached and does not evict a valid entry", () => {
  let attempts = 0;
  const failure = new Error("invalid SQL");
  const split = createSqlSplitCache((sql) => {
    if (sql === "retry" && ++attempts === 1) throw failure;
    return [sql];
  }, 1);
  const valid = split("valid");
  assert.throws(() => split("retry"), (error) => error === failure);
  assert.equal(split("valid"), valid);
  const retried = split("retry");
  assert.deepEqual(retried, ["retry"]);
  assert.equal(split("retry"), retried);
  assert.equal(attempts, 2);
});

test("bounded cache evicts the least recently used SQL and reparses it", () => {
  const calls = [];
  const split = createSqlSplitCache((sql) => { calls.push(sql); return [sql]; }, 2);
  const first = split("first");
  const second = split("second");
  assert.equal(split("first"), first);
  split("third");
  assert.equal(split("first"), first);
  assert.notEqual(split("second"), second);
  assert.deepEqual(calls, ["first", "second", "third", "second"]);
});

test("cache capacity rejects unbounded or nonpositive values", () => {
  for (const capacity of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSqlSplitCache((sql) => [sql], capacity), RangeError);
  }
});
