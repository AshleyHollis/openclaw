import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayControlUiPluginTab, GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { pluginNotificationNavigationFromSearch } from "./plugin-notification-navigation.ts";
import { externalTabBridgeGrant } from "./plugin-page.test-helpers.ts";
import { PluginPage } from "./plugin-page.ts";

class NotificationBridgePluginPage extends PluginPage {
  readonly requestedDocumentPaths: string[] = [];

  protected override async loadCapabilityBridgeDocument(path: string, _signal: AbortSignal) {
    this.requestedDocumentPaths.push(path);
    return null;
  }
}

const testElementName = "openclaw-notification-bridge-plugin-page-test";
if (!customElements.get(testElementName)) {
  customElements.define(testElementName, NotificationBridgePluginPage);
}

describe("PluginPage notification capability bridge", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only bounded typed notification targets for the declared tab", () => {
    expect(
      pluginNotificationNavigationFromSearch(
        "?notification=plugin-detail&destination=item&record=record-1",
        "board",
        "items",
      ),
    ).toEqual({
      kind: "plugin-detail",
      pluginId: "board",
      tabId: "items",
      destinationId: "item",
      recordId: "record-1",
    });
    expect(
      pluginNotificationNavigationFromSearch(
        "?notification=plugin-detail&destination=item&record=https://outside.test",
        "board",
        "items",
      ),
    ).toBeUndefined();
  });

  it("loads the provenance-bound bridge document with the bounded notification destination", async () => {
    const info: GatewayControlUiPluginTab = {
      pluginId: "external-plugin",
      id: "panel",
      label: "External panel",
      path: "/plugins/external/panel",
      requiresGatewayAuth: true,
      capabilityBridge: externalTabBridgeGrant(),
    };
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: {
        authorityId: "notification-bridge-authority",
        role: "operator",
        scopes: ["operator.write"],
      },
      controlUiTabs: [info],
    };
    const snapshot = {
      phase: "connected",
      hello,
      client: null,
    } as unknown as ApplicationGatewaySnapshot;
    const page = document.createElement(testElementName) as NotificationBridgePluginPage;
    page.pluginId = info.pluginId;
    page.tabId = info.id;
    page.notificationTarget = {
      kind: "plugin-detail",
      pluginId: info.pluginId,
      tabId: info.id,
      destinationId: "inbox",
      recordId: "record-1",
    };
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot },
    } as unknown as ApplicationContext<RouteId>;
    const internals = page as unknown as {
      externalAuthReadyKey: string | null;
      externalTabAuthKey: (tab: GatewayControlUiPluginTab, bundled: boolean) => string | null;
      syncCapabilityBridgeDocument: (tab: GatewayControlUiPluginTab, bundled: boolean) => void;
    };
    internals.externalAuthReadyKey = internals.externalTabAuthKey(info, false);

    internals.syncCapabilityBridgeDocument(info, false);

    await waitForFast(() =>
      expect(page.requestedDocumentPaths).toEqual([
        "/plugins/external/panel?openclawNotification=plugin-detail&destination=inbox&record=record-1",
      ]),
    );
  });
});
