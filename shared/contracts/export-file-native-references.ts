import type { ExportSchemaObject, ExportTables } from "./export";
import { stableJson } from "../domain/content-addressing";
import { canonicalFileAuthoritySchemaSql } from "./export-file-authority";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid native File relational graph ${reason}`);
}
const identifier = (value: string) => value.trim().replace(/^["`\[]|["`\]]$/g, "");
const columns = (value: string) => value.split(",").map(identifier);

/** The caller first authenticates the pinned successor schema. This parser
 * reads its declared column/foreign keys, never executes archive SQL. */
function declarations(sql: string) {
  const start = sql.indexOf("("), result: string[] = [];
  let depth = 1, quote = "", offset = start + 1, last = offset;
  ensure(start >= 0, "table definition");
  for (; offset < sql.length; offset += 1) {
    const char = sql[offset];
    if (quote) {
      if (char === quote) {
        if (sql[offset + 1] === quote) offset += 1;
        else quote = "";
      }
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) { result.push(sql.slice(last, offset)); break; }
    } else if (char === "," && depth === 1) { result.push(sql.slice(last, offset)); last = offset + 1; }
  }
  ensure(depth === 0 && !quote, "complete table definition");
  return result.map(part => part.trim());
}

function columnConstraintText(part: string) {
  let depth = 0, quote = "", output = "";
  for (let offset = 0; offset < part.length; offset += 1) {
    const char = part[offset];
    if (quote) {
      if (char === quote) { if (part[offset + 1] === quote) offset += 1; else quote = ""; }
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0) output += char;
  }
  return output;
}

export function validateFileNativeReferences(tables: ExportTables, schema: ExportSchemaObject[]) {
  const definitions = new Map(schema.filter(object => object.type === "table" && Object.hasOwn(tables, object.name))
    .map(object => [object.name, declarations(canonicalFileAuthoritySchemaSql(String(object.sql)).join(" "))]));
  const primaryKeys = new Map<string, string[]>();
  for (const [name, parts] of definitions) {
    const tableKey = parts.find(part => /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(/i.test(part));
    const inline = parts.find(part => !/^(?:CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|CHECK)\b/i.test(part) && /\bPRIMARY\s+KEY\b/i.test(part));
    const key = tableKey ? columns(tableKey.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i)![1])
      : inline ? [identifier(inline.match(/^(["`\[]?\w+["`\]]?)/)![1])] : [];
    primaryKeys.set(name, key);
    if (key.length) {
      const seen = new Set<string>();
      for (const row of tables[name]) {
        const value = stableJson(key.map(column => row[column]));
        ensure(!seen.has(value), `${name} duplicate primary key`); seen.add(value);
      }
    }
    const uniqueKeys = parts.flatMap(part => {
      const tableUnique = part.match(/^(?:CONSTRAINT\s+\S+\s+)?UNIQUE\s*\(([^)]+)\)/i);
      if (tableUnique) return [columns(tableUnique[1])];
      if (!/^(?:CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|CHECK)\b/i.test(part) && /\bUNIQUE\b/i.test(columnConstraintText(part)))
        return [[identifier(part.match(/^(["`\[]?\w+["`\]]?)/)![1])]];
      return [];
    });
    for (const uniqueKey of uniqueKeys) {
      const seen = new Set<string>();
      for (const row of tables[name]) {
        const tuple = uniqueKey.map(column => row[column]);
        if (tuple.some(value => value === null)) continue;
        const value = stableJson(tuple);
        ensure(!seen.has(value), `${name} duplicate unique identity`); seen.add(value);
      }
    }
    for (const part of parts) {
      if (/^(?:CONSTRAINT|FOREIGN|PRIMARY|UNIQUE|CHECK)\b/i.test(part) || !/\bNOT\s+NULL\b/i.test(columnConstraintText(part))) continue;
      const column = identifier(part.match(/^(["`\[]?\w+["`\]]?)/)![1]);
      ensure(tables[name].every(row => row[column] !== null && row[column] !== undefined), `${name}.${column} required value`);
    }
  }
  for (const [name, parts] of definitions) for (const part of parts) {
    const reference = part.match(/\bREFERENCES\s+(["`\[]?\w+["`\]]?)(?:\s*\(([^)]+)\))?/i);
    if (!reference) continue;
    const target = identifier(reference[1]);
    const composite = part.match(/FOREIGN\s+KEY\s*\(([^)]+)\)/i);
    const from = composite ? columns(composite[1]) : [identifier(part.match(/^(["`\[]?\w+["`\]]?)/)![1])];
    const to = reference[2] ? columns(reference[2]) : primaryKeys.get(target);
    ensure(Object.hasOwn(tables, target) && to && to.length === from.length, `${name} complete referenced inventory ${target}`);
    const values = new Set(tables[target].map(row => stableJson(to.map(column => row[column]))));
    for (const row of tables[name]) {
      const key = from.map(column => row[column]);
      if (key.some(value => value === null)) continue;
      ensure(values.has(stableJson(key)), `${name} foreign key to ${target}`);
    }
  }
}
