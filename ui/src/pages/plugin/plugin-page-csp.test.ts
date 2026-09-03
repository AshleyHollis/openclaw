import { describe, expect, it } from "vitest";
import { CAPABILITY_BRIDGE_BOOTSTRAP_SOURCE } from "../../../../src/gateway/control-ui-capability-bridge-bootstrap.js";
import { buildCapabilityBridgeDocument } from "./plugin-page.ts";

describe("PluginPage capability bridge CSP", () => {
  it("keeps mount provenance out of the CSP-authorized bootstrap body", () => {
    const bootstrapId = "0123456789abcdef0123456789abcdef";
    const document = buildCapabilityBridgeDocument(
      new URL("https://gateway.example/plugins/external/panel"),
      "<main>External panel</main>",
      bootstrapId,
    );
    const script = document.match(/<script ([^>]*)>([^]*?)<\/script>/);

    expect(script?.[1]).toBe(`data-openclaw-capability-bridge-bootstrap-id="${bootstrapId}"`);
    expect(script?.[2]).toBe(CAPABILITY_BRIDGE_BOOTSTRAP_SOURCE);
    expect(script?.[2]).not.toContain(bootstrapId);
  });
});
