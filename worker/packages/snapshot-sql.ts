/** Factor a closed UNION ALL without a compound SELECT. Each ordinal selects
 * exactly one materialized leaf; its equality join can use SQLite's automatic
 * index. Other leaves contribute only NULLs, so nullable values and duplicate
 * rows survive unchanged. This is internal SQL, never package-supplied SQL. */
export function packageUnionAllCtes(name: string, columns: readonly string[], leaves: readonly string[]): string {
  if (!leaves.length || leaves.length > 63 || !columns.length) throw new Error("Invalid closed capture SQL shape");
  const selectors = `${name}_selector`;
  const aliases = leaves.map((_, index) => `${name}_leaf_${index}`);
  const definitions = leaves.map((sql, index) => `${aliases[index]}(__capture_branch,${columns.join(",")}) AS MATERIALIZED(
    SELECT ${index},leaf.* FROM(${sql}) leaf)`);
  const coalesce = (column: string) => aliases.length === 1 ? `${aliases[0]}.${column}`
    : `COALESCE(${aliases.map(alias => `${alias}.${column}`).join(",")})`;
  return [...definitions, `${selectors}(__capture_branch) AS MATERIALIZED(VALUES ${leaves.map((_, index) => `(${index})`).join(",")})`,
    `${name} AS MATERIALIZED(SELECT ${columns.map(column => `${coalesce(column)} ${column}`).join(",")}
      FROM ${selectors} ${aliases.map(alias => `LEFT JOIN ${alias} ON ${alias}.__capture_branch=${selectors}.__capture_branch`).join("\n      ")}
      WHERE ${coalesce("__capture_branch")} IS NOT NULL)`].join(",\n ");
}
