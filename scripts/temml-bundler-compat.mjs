/**
 * Rolldown 1.1.5 corrupts lone UTF-16 surrogates when folding Temml's lexer
 * strings. Keep those ranges as RegExp escapes until the lexer is constructed.
 * This preserves their meaning without changing Temml or other dependencies.
 */
export function temmlBundlerCompat() {
  return {
    name: "temml-lexer-surrogate-compat",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/temml/dist/temml.mjs")) return null;
      const escaped = code.replace(/(?<!\\)\\uD(?:800|BFF|C00|FFF)/g, (match) => `\\${match}`);
      return escaped === code ? null : { code: escaped, map: null };
    },
  };
}
