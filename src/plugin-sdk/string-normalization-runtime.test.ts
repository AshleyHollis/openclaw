import { stableStringify as canonicalStableStringify } from "@openclaw/normalization-core/stable-stringify";
import { stableStringify } from "openclaw/plugin-sdk/string-normalization-runtime";
import { expect, it } from "vitest";

it("exposes the canonical serializer without wrapping or changing normalization defaults", () => {
  expect(stableStringify).toBe(canonicalStableStringify);
});
