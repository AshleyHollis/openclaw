/**
 * Runtime SDK subpath for shared slug, string-entry, and stable serialization helpers.
 */
export {
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../../packages/normalization-core/src/string-normalization.js";
export { stableStringify } from "../../packages/normalization-core/src/stable-stringify.js";
