import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import {
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
} from "../logging/redact.js";
import type { AgentMessage } from "./runtime/index.js";
import {
  sanitizeTranscriptImageDataUrlField,
  sanitizeTranscriptImageRecord,
  shouldPreserveNestedTranscriptImageDataUrlFields,
} from "./transcript-sanitize-images.js";

const transcriptPagingField = /^(?:next[_-]?)?page[_-]?token$|^page[_-]?cursor$/i;

/** Reproduce the retained config-aware storage projection for imported user history. */
export function redactHistoricalUserTranscriptMessage(
  message: AgentMessage,
  config?: OpenClawConfig,
): AgentMessage {
  if (message.role !== "user") {
    throw new Error("Historical transcript redaction requires a user message");
  }
  const redactPatterns = config?.logging?.redactPatterns ?? readLoggingConfig()?.redactPatterns;
  const logging = redactPatterns ? { redactPatterns: [...redactPatterns] } : undefined;
  const seen = new WeakSet<object>();

  function redact(value: unknown, field?: string, preserveImageUrl = false): unknown {
    if (typeof value === "string") {
      return field && !transcriptPagingField.test(field)
        ? redactSensitiveFieldValueWithConfig(field, value, logging)
        : redactToolPayloadTextWithConfig(value, logging);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const entries = value.map((entry) => redact(entry, field, preserveImageUrl));
        return entries.some((entry, index) => entry !== value[index]) ? entries : value;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return value;
      }
      const original = asOptionalRecord(value)!;
      const image = sanitizeTranscriptImageRecord(original);
      const source = image ?? original;
      let output = source === original ? undefined : { ...source };
      for (const [key, item] of Object.entries(source)) {
        if ((value === message && key === "idempotencyKey") || (image && key === "data")) {
          continue;
        }
        const imageUrl =
          typeof item === "string"
            ? sanitizeTranscriptImageDataUrlField({
                source,
                key,
                value: item,
                preserveImageDataUrlFields: preserveImageUrl,
              })
            : undefined;
        const next =
          imageUrl ??
          redact(
            item,
            key,
            preserveImageUrl || shouldPreserveNestedTranscriptImageDataUrlFields(source, key),
          );
        if (next !== item) {
          output ??= { ...source };
          output[key] = next;
        }
      }
      if (field === "__openclaw" && output) {
        if (
          output.senderIdentity !== source.senderIdentity ||
          output.senderId !== source.senderId
        ) {
          delete output.senderIdentity;
        }
        if (output.humanMentions !== source.humanMentions) {
          delete output.humanMentions;
        }
      }
      if (value === message && output && output.content !== source.content) {
        const metadata = asOptionalRecord(output.__openclaw);
        if (metadata?.humanMentions !== undefined) {
          const retained = { ...metadata };
          delete retained.humanMentions;
          output.__openclaw = retained;
        }
      }
      return output ?? original;
    } finally {
      seen.delete(value);
    }
  }
  // SAFETY: The historical user projection retains the admitted message envelope.
  return redact(message) as AgentMessage;
}
