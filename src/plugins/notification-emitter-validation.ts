type NotificationCandidateShape = {
  emissionId: string;
  logicalOperationId: string;
  attentionClass: "active" | "time-sensitive";
  preview: { title: string; body: string };
  deepLink: { destinationId: string; recordId: string };
  expiresAtMs: number;
};

export const failure = () =>
  ({
    status: "failed",
    attempted: 0,
    delivered: 0,
    failed: 1,
    ambiguous: 0,
  }) as const;

export const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key));

function scalar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

export const boundedText = (value: unknown, max: number): value is string => {
  if (typeof value !== "string" || !scalar(value) || containsControlCharacter(value)) {
    return false;
  }
  const codePointLength = Array.from(value).length;
  return codePointLength > 0 && codePointLength <= max;
};

export function canonical(candidate: NotificationCandidateShape): string {
  return JSON.stringify({
    version: 1,
    emissionId: candidate.emissionId,
    logicalOperationId: candidate.logicalOperationId,
    attentionClass: candidate.attentionClass,
    preview: { title: candidate.preview.title, body: candidate.preview.body },
    deepLink: {
      kind: "plugin-detail",
      destinationId: candidate.deepLink.destinationId,
      recordId: candidate.deepLink.recordId,
    },
    expiresAtMs: candidate.expiresAtMs,
  });
}
