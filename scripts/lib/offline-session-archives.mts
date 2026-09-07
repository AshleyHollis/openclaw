import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { canonicalizePersistedUserMessageMedia } from "../../src/media/media-facts.js";
import { assertLosslessReserialization } from "./offline-session-json.mts";

export const MAX_OFFLINE_ARCHIVE_BYTES = 256 * 1024 * 1024;

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodedContent(bytes: Uint8Array, compressed: boolean, maxBytes: number): string {
  if (bytes.byteLength > MAX_OFFLINE_ARCHIVE_BYTES) {
    throw new Error("Offline archive exceeds the stored-byte limit.");
  }
  const decoded = compressed ? zstdDecompressSync(bytes, { maxOutputLength: maxBytes }) : bytes;
  if (decoded.byteLength > maxBytes) {
    throw new Error("Offline archive exceeds the decoded-byte limit.");
  }
  // Retain a BOM so JSON parsing agrees with native Buffer.toString behavior.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded);
}

/** Capture exact expected content before the native owner changes archive bytes. */
export function captureOfflineSessionArchive(
  bytes: Uint8Array,
  options: { compressed: boolean; maxDecodedBytes?: number },
) {
  const { compressed, maxDecodedBytes = MAX_OFFLINE_ARCHIVE_BYTES } = options;
  if (
    !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    maxDecodedBytes > MAX_OFFLINE_ARCHIVE_BYTES
  ) {
    throw new Error("Offline archive requires a positive bounded decoding limit.");
  }
  const original = decodedContent(bytes, compressed, maxDecodedBytes);
  const recovered = original.replace(/\0+$/u, "");
  if (original !== "" && recovered === "") {
    throw new Error("Offline archive has no records before its terminal NUL suffix.");
  }
  const lines =
    recovered === ""
      ? []
      : (recovered.endsWith("\n") ? recovered.slice(0, -1) : recovered).split("\n");
  let mediaChanged = false;
  const records = lines.map((line): unknown => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Offline archive contains invalid JSONL framing.");
    }
    if (isRecord(event) && event.type === "message" && isRecord(event.message)) {
      const canonical = canonicalizePersistedUserMessageMedia(event.message);
      if (canonical.changed) {
        mediaChanged = true;
        return { ...event, message: canonical.message };
      }
    }
    return event;
  });
  if (mediaChanged) {
    for (const line of lines) {
      assertLosslessReserialization(line);
    }
  }
  const expected = mediaChanged
    ? `${records.map((record) => JSON.stringify(record)).join("\n")}${recovered.endsWith("\n") ? "\n" : ""}`
    : recovered;
  const preparedDecodedBytes = Buffer.byteLength(expected);
  if (preparedDecodedBytes > maxDecodedBytes) {
    throw new Error("Offline converted archive exceeds the decoded-byte limit.");
  }
  const sourceSha256 = digest(bytes);
  const expectedSha256 = digest(expected);
  const changed = expected !== original;
  return Object.freeze({
    sourceSha256,
    decodedBytes: Buffer.byteLength(original),
    preparedDecodedBytes,
    assertPrepared(prepared: Uint8Array): void {
      // Unchanged compressed archives must retain their original encoded bytes.
      const matches = changed
        ? digest(decodedContent(prepared, compressed, maxDecodedBytes)) === expectedSha256
        : digest(prepared) === sourceSha256;
      if (!matches) {
        throw new Error("Offline archive preservation check failed.");
      }
    },
  });
}
