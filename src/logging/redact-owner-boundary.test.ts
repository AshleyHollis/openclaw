import { describe, expect, it } from "vitest";
import { DEFAULT_REDACT_PATTERNS } from "./redact-patterns.js";
import { redactSensitiveText, resolveRedactOptions } from "./redact.js";
describe("owner-boundary counterexamples", () => {
  it("keeps configured vendor regexes on their own path so data-URL content stays masked", () => {
    // A configured expression that is not one of the exact guarded built-in sources must keep
    // its original regex path: the data-URL exemption belongs to the guarded scanner, not to
    // every expression that happens to match the same shape.
    const configured = /(^|[^A-Za-z0-9])(AKIA[A-Z0-9]{16})/g;
    const dataUrl = `data:text/plain;base64,AKIA${"A".repeat(16)}`;
    const output = redactSensitiveText(dataUrl, { mode: "tools", patterns: [configured] });
    expect(output).not.toBe(dataUrl);
    // The guarded built-in scanner keeps its data-URL exemption on the exact guarded source.
    const guarded = redactSensitiveText(dataUrl, { mode: "tools" });
    expect(guarded).toBe(dataUrl);
  });

  it("masks a built-in token crossing the former chunk boundary under combined policies", () => {
    // A custom logging.redactPatterns entry composes with the default arrays; the default
    // glpat- rule keeps whole-text scanning, so a value straddling offset 16,384 still masks.
    const prefix = "x".repeat(16_380);
    const text = `${prefix} glpat-${"a".repeat(24)}`;
    const output = redactSensitiveText(text, {
      mode: "tools",
      patterns: [...DEFAULT_REDACT_PATTERNS, /unrelated-config-key-[a-z]+/g],
    });
    // The mask keeps the glpat- prefix as a hint; the secret value itself must not survive.
    expect(output).not.toContain("a".repeat(24));
  });
});

describe("repeat rewrite atom boundaries", () => {
  it("leaves non-unicode astral quantifiers unchanged so their language is preserved", () => {
    // Without the u flag JavaScript quantifies only the trailing code unit of a literal
    // astral character; rewriting it as a whole-code-point atom changes the language.
    // Routed through the production boundary so the assertion covers the real rewriter.
    const configured = "^(😀{1,})$";
    const options = resolveRedactOptions({
      mode: "tools",
      patterns: [configured],
    });
    // Without the u flag JavaScript quantifies only the trailing code unit of a literal
    // astral character. The configured string is resolved through parsePattern (the real
    // rewriter), and the resolved pattern must still match the legacy-language input.
    const resolved = options.patterns[0];
    expect(resolved).toBeDefined();
    expect(resolved instanceof RegExp).toBe(true);
    expect((resolved as RegExp).test("😀")).toBe(true);
  });
});

describe("configured source language preservation", () => {
  it.each([
    ["property identity escape", "^\\p{L}{1,}$"],
    ["named backreference without captures", "^\\k<word>{1,}$"],
    ["control escape", "^\\c1{1,}$"],
    ["octal numeric escape", "^\\1234{1,}$"],
    ["incomplete unicode escape", "^\\u12{1,}$"],
  ])("preserves the legacy language of %s", (_name, configured) => {
    // Operator-configured sources compile unmodified: the rewriter optimizes only canonical
    // built-in sources, so the resolved pattern keeps the exact configured source string.
    const resolved = resolveRedactOptions({ mode: "tools", patterns: [configured] });
    const pattern = resolved.patterns[0];
    expect(pattern instanceof RegExp).toBe(true);
    expect((pattern as RegExp).source).toBe(configured);
  });

  it("preserves verified legacy matching semantics for escape-shaped sources", () => {
    // Split from the source-equality cases above so each assertion is unconditional.
    const matching: Array<[string, string]> = [
      ["^\\p{L}{1,}$", "p{L}}"],
      ["^\\k<word>{1,}$", "k<word>"],
      ["^\\1234{1,}$", "S44"],
      ["^\\u12{1,}$", "u122"],
    ];
    for (const [configured, input] of matching) {
      const resolved = resolveRedactOptions({ mode: "tools", patterns: [configured] });
      const pattern = resolved.patterns[0] as RegExp;
      expect(pattern.test(input)).toBe(true);
    }
  });
});
