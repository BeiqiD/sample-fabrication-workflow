import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("processing action menus", () => {
  it("uses the shared option height for Add and State menus", () => {
    expect(styles).toMatch(
      /\.state-action-panel button\s*\{[^}]*min-height:\s*29px;/,
    );
    expect(styles).not.toMatch(
      /\.add-action-panel button\s*\{[^}]*min-height:/,
    );
  });
});
