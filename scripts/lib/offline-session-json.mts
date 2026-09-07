function decimalIdentity(literal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(literal);
  if (!match) {
    throw new Error("Offline content conversion would produce lossy JSON.");
  }
  const [, sign, integer, fraction = "", exponent = "0"] = match;
  const digits = `${integer}${fraction}`.replace(/^0+/u, "");
  if (!digits) {
    return `${sign}0`;
  }
  const coefficient = digits.replace(/0+$/u, "");
  const power = Number(exponent) - fraction.length + digits.length - coefficient.length;
  if (!Number.isSafeInteger(power)) {
    throw new Error("Offline content conversion would produce lossy JSON.");
  }
  return `${sign}${coefficient}e${power}`;
}

/** Syntax is already validated; admit only lossless native parse/stringify rewrites. */
export function assertLosslessReserialization(line: string): void {
  const scopes: Array<Set<string> | null> = [];
  const keySuffix = /\s*:/uy;
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]]/gu;
  for (const match of line.matchAll(tokens)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      scopes.push(token === "{" ? new Set<string>() : null);
    } else if (token === "}" || token === "]") {
      scopes.pop();
    } else if (token.startsWith('"')) {
      keySuffix.lastIndex = match.index + token.length;
      if (keySuffix.test(line)) {
        const key: unknown = JSON.parse(token);
        const scope = scopes.at(-1);
        if (typeof key !== "string" || !scope || scope.has(key)) {
          throw new Error("Offline content conversion would produce lossy JSON.");
        }
        scope.add(key);
      }
    } else {
      const value = Number(token);
      if (
        !Number.isFinite(value) ||
        decimalIdentity(token) !== decimalIdentity(JSON.stringify(value))
      ) {
        throw new Error("Offline content conversion would produce lossy JSON.");
      }
    }
  }
}
