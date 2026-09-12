import assert from "node:assert/strict";
import { rolldown } from "rolldown";
import { temmlBundlerCompat } from "./temml-bundler-compat.mjs";

// Source-only renderer tests cannot catch dependency optimizer corruption.
// Exercise both development and production transforms with real MathML checks.
for (const minify of [false, true]) {
  const bundle = await rolldown({
    input: "src/lib/rich-text.ts",
    plugins: [temmlBundlerCompat()],
  });
  try {
    const { output } = await bundle.generate({ format: "esm", minify });
    const chunk = output.find((item) => item.type === "chunk" && item.isEntry);
    assert.ok(chunk, "renderer bundle must contain an entry");
    const { renderRichText } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
    for (const mode of ["document", "comment"]) {
      const fraction = renderRichText(String.raw`$\frac{1}{1+x}$`, mode);
      assert.match(fraction, /<mfrac\b/);
      const matrix = renderRichText(String.raw`$$
\begin{pmatrix}a & b \\ c & d\end{pmatrix}
$$`, mode);
      assert.match(matrix, /<mtable\b/);
      assert.equal((matrix.match(/<mtr\b/g) ?? []).length, 2);
      const commands = renderRichText(String.raw`$\int_0^L \alpha(z)\,dz + P_{\mathrm{abs}} + \text{cost \$5} + 𝑥$`, mode);
      assert.match(commands, /<mo[^>]*>∫<\/mo>/);
      assert.match(commands, /<mi[^>]*>α<\/mi>/);
      for (const html of [fraction, matrix, commands]) {
        assert.doesNotMatch(html, /rich-text-math-error|temml-error|mathcolor="red"/);
      }
      assert.match(renderRichText(String.raw`$\frac{1}{$`, mode), /rich-text-math-error/);
      assert.equal(renderRichText("`$x^2$`", mode).includes("<math"), false);
    }
    console.log(`Bundled rich text: ${minify ? "production" : "development"} formulas passed`);
  } finally {
    await bundle.close();
  }
}
