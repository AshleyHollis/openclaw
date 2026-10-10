/**
 * Runtime SDK subpath for shared string normalization and deterministic serialization.
 */
export { stableStringify } from "../../packages/normalization-core/src/stable-stringify.js";
export {
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../../packages/normalization-core/src/string-normalization.js";
