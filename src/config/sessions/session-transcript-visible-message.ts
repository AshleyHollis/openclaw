import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../../packages/agent-core/src/index.js";

export type SessionTranscriptMessageEntry = {
  /** Stable transcript event id for this message entry. */
  entryId: string;
  /** Parent id after active-branch normalization; null when this is a visible root. */
  parentId: string | null;
  /** Ordered read metadata for this full transcript read, not a resumable cursor. */
  seq: number;
  /** Redacted agent message payload as persisted by the runtime. */
  message: AgentMessage;
  /** Convenience mirror of message.role. */
  role: AgentMessage["role"];
  /** Entry timestamp recorded by the transcript store, when present. */
  createdAt?: string;
  /** Message idempotency key, when the persisted message has one. */
  idempotencyKey?: string;
};

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && readNonEmptyString(value.role) !== undefined;
}

export function projectVisibleMessageEntry(entry: {
  event: unknown;
  parentId: string | null;
  seq: number;
}): SessionTranscriptMessageEntry[] {
  const event = entry.event;
  if (!isRecord(event) || event.type !== "message") {
    return [];
  }
  const entryId = readNonEmptyString(event.id);
  const message = event.message;
  if (!entryId || !isAgentMessageRecord(message)) {
    return [];
  }
  const createdAt = readNonEmptyString(event.timestamp);
  const idempotencyKey = readNonEmptyString(message.idempotencyKey);
  return [
    {
      entryId,
      parentId: entry.parentId,
      seq: entry.seq,
      message,
      role: message.role,
      ...(createdAt ? { createdAt } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  ];
}

/** Version 1 hashes canonical JSON of the public, already storage-redacted message.
 * Entry identity, active-path membership and generation are admitted separately.
 * The complete persisted message, including its own timestamp, participates.
 * Entry-envelope timestamps and raw event sequence do not participate.
 */
export function createSessionTranscriptVisibleMessageDigest(
  entry: SessionTranscriptMessageEntry,
): string {
  return `sha256-public-message-v1:${createHash("sha256")
    .update(stableStringify(entry.message))
    .digest("hex")}`;
}
