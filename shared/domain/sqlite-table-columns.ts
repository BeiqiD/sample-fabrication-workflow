type Token = { text: string; quoted: boolean };

function fail(): never { throw new Error("Invalid recorded SQLite table definition"); }

// Parse only the CREATE TABLE column-name boundary. This never evaluates SQL,
// defaults, generated expressions, triggers, archive DDL or external files.
export function sqliteTableColumns(sql: string, expectedTable: string): string[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const rest = sql.slice(offset);
    const space = /^[\t\n\f\r ]+/.exec(rest);
    if (space) { offset += space[0].length; continue; }
    if (rest.startsWith("--")) { const end = sql.indexOf("\n", offset + 2); offset = end < 0 ? sql.length : end + 1; continue; }
    if (rest.startsWith("/*")) { const end = sql.indexOf("*/", offset + 2); if (end < 0) fail(); offset = end + 2; continue; }
    const opener = sql[offset];
    if (["'", '"', "`", "["].includes(opener)) {
      const closer = opener === "[" ? "]" : opener;
      offset += 1;
      let text = "", closed = false;
      while (offset < sql.length) {
        const character = sql[offset++];
        if (character !== closer) { text += character; continue; }
        if (opener !== "[" && sql[offset] === closer) { text += closer; offset += 1; continue; }
        closed = true;
        break;
      }
      if (!closed) fail();
      tokens.push({ text, quoted: true });
      continue;
    }
    const token = /^[A-Za-z0-9_$\u0080-\u{10FFFF}]+|./u.exec(rest)?.[0];
    if (!token) fail();
    tokens.push({ text: token, quoted: false });
    offset += token.length;
  }
  let cursor = 0;
  const keyword = (word: string) => !tokens[cursor]?.quoted && tokens[cursor]?.text.toUpperCase() === word;
  const take = (word: string) => { if (!keyword(word)) fail(); cursor += 1; };
  take("CREATE");
  if (keyword("TEMP") || keyword("TEMPORARY")) cursor += 1;
  take("TABLE");
  if (keyword("IF")) { take("IF"); take("NOT"); take("EXISTS"); }
  if (tokens[cursor]?.text !== expectedTable) fail();
  cursor += 1;
  take("(");
  let depth = 1;
  let entry: Token[] = [];
  const columns: string[] = [];
  const consume = () => {
    if (!entry.length) fail();
    const first = entry[0];
    if (first.quoted || !["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"].includes(first.text.toUpperCase())) {
      if (!first.text || !first.quoted && !/^[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_$\u0080-\u{10FFFF}]*$/u.test(first.text)) fail();
      if (columns.includes(first.text)) fail();
      columns.push(first.text);
    }
    entry = [];
  };
  while (cursor < tokens.length && depth) {
    const token = tokens[cursor++];
    if (!token.quoted && token.text === "(") depth += 1;
    if (!token.quoted && token.text === ")") depth -= 1;
    if (depth === 0) { consume(); break; }
    if (!token.quoted && token.text === "," && depth === 1) consume();
    else entry.push(token);
  }
  if (depth !== 0 || !columns.length) fail();
  const suffix = tokens.slice(cursor);
  if (suffix.at(-1)?.text === ";" && !suffix.at(-1)?.quoted) suffix.pop();
  if (suffix.some((token) => token.quoted)) fail();
  const tail = suffix.map((token) => token.text.toUpperCase()).join(" ");
  if (!["", "STRICT", "WITHOUT ROWID", "WITHOUT ROWID , STRICT", "STRICT , WITHOUT ROWID"].includes(tail)) fail();
  return columns;
}
