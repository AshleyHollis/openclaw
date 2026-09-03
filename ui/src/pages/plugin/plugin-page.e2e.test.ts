import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../../src/gateway/control-ui-csp.js";
import type { GatewayControlUiPluginTab } from "../../api/gateway.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const viewport = { height: 900, width: 1280 };

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

async function createPage(): Promise<Page> {
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
  }
  const context = await browser.newContext({
    viewport,
    ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
  });
  openContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents = [];
    (window as Window & { capabilityBootstrapEvents?: string[] }).capabilityBootstrapEvents = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type?.startsWith("external-bridge-e2e:")) {
        (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents?.push(
          event.data,
        );
      }
      if (event.data?.type?.startsWith("openclaw:capability-bridge-bootstrap")) {
        (
          window as Window & { capabilityBootstrapEvents?: string[] }
        ).capabilityBootstrapEvents?.push(event.data.type);
      }
    });
  });
  return page;
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (artifactDir) {
    await page.screenshot({ fullPage: true, path: path.join(artifactDir, `${name}.png`) });
  }
}

const externalTab: GatewayControlUiPluginTab = {
  pluginId: "external-plugin",
  id: "panel",
  label: "External panel",
  path: "/plugins/external/panel",
  requiresGatewayAuth: true,
  capabilityBridge: {
    protocolVersion: 1,
    mode: "read-only",
    methods: ["chat.history"],
    readMethods: ["chat.history"],
    missingRequiredMethods: [],
    upgradeRequired: false,
    linkedSessionKeys: ["agent:main:owned"],
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxConcurrentRequests: 8,
      maxRequestsPerMinute: 60,
      maxMutationsPerMinute: 12,
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
    },
  },
};

const externalMutationTab: GatewayControlUiPluginTab = {
  ...externalTab,
  capabilityBridge: {
    protocolVersion: 1,
    mode: "read-write",
    methods: ["plugin.example.write"],
    readMethods: [],
    missingRequiredMethods: [],
    upgradeRequired: false,
    linkedSessionKeys: ["agent:main:owned"],
    limits: {
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxConcurrentRequests: 8,
      maxRequestsPerMinute: 60,
      maxMutationsPerMinute: 12,
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
    },
  },
};

function externalPluginDocument(): string {
  return `<!doctype html><script>
    const send = (payload) => window.postMessage({ type: "openclaw:capability-bridge-send", protocolVersion: 1, payload }, "*");
    const requestHistory = (requestId) => send({
      type: "openclaw:capability-bridge-request",
      requestId,
      method: "chat.history",
      params: { sessionKey: "agent:main:owned", limit: 1 },
    });
    window.addEventListener("message", (event) => {
      if (event.data?.type === "external-bridge-e2e:retry") {
        parent.postMessage({ type: "external-bridge-e2e:retry-sent" }, "*");
        requestHistory("history-retry");
      }
      if (event.source !== window || event.data?.type !== "openclaw:capability-bridge-receive" || event.data.protocolVersion !== 1) return;
      const message = event.data.payload;
      if (message?.type === "openclaw:capability-bridge-ready") {
        parent.postMessage({ type: "external-bridge-e2e:ready", relayProtocolVersion: event.data.protocolVersion, value: message }, "*");
        requestHistory("history-initial");
      }
      if (message?.type === "openclaw:capability-bridge-response") {
        parent.postMessage({ type: "external-bridge-e2e:response", value: message }, "*");
      }
    });
    let parentReadable = false;
    try { parentReadable = Boolean(parent.document.body); } catch {}
    parent.postMessage({ type: "external-bridge-e2e:isolation", parentReadable }, "*");
    send({ type: "openclaw:capability-bridge-hello", protocolVersion: 1 });
  </script>`;
}

function externalPluginMutationDocument(): string {
  return `<!doctype html><script>
    const send = (payload) => window.postMessage({ type: "openclaw:capability-bridge-send", protocolVersion: 1, payload }, "*");
    const write = () => send({
      type: "openclaw:capability-bridge-request",
      requestId: crypto.randomUUID(),
      operationId: "stable-plugin-write",
      method: "plugin.example.write",
      params: { enabled: true },
    });
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.type !== "openclaw:capability-bridge-receive" || event.data.protocolVersion !== 1) return;
      if (event.data.payload?.type === "openclaw:capability-bridge-ready") {
        parent.postMessage({ type: "external-bridge-e2e:mutation-ready" }, "*");
        write();
      }
      if (event.data.payload?.type === "openclaw:capability-bridge-response") {
        parent.postMessage(
          { type: "external-bridge-e2e:mutation-response", value: event.data.payload },
          "*",
        );
      }
    });
    send({ type: "openclaw:capability-bridge-hello", protocolVersion: 1 });
  </script>`;
}

async function applyGatewayCspToControlUi(page: Page): Promise<void> {
  await page.route("**/plugin?plugin=external-plugin&id=panel", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body,
      headers: {
        ...response.headers(),
        "content-security-policy": buildControlUiCspHeader({
          inlineScriptHashes: computeInlineScriptHashes(body),
        }),
      },
    });
  });
}

async function routeExternalPlugin(page: Page, documentMarkup = externalPluginDocument()) {
  await page.route("**/plugins/external/panel**", async (route) => {
    const url = new URL(route.request().url());
    const nonce = url.searchParams.get("__openclaw_plugin_frame_auth_probe");
    if (nonce) {
      await route.fulfill({
        contentType: "text/html",
        body: `<script>parent.postMessage({type:"openclaw-plugin-frame-auth-probe",nonce:${JSON.stringify(nonce)}},"*")</script>`,
      });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: documentMarkup });
  });
}

function bridgeScenario(tab = externalTab) {
  return {
    controlUiTabs: [tab],
    embedSandbox: "trusted" as const,
    featureMethods: ["chat.history", "chat.metadata", "chat.startup", "plugin.example.write"],
    methodResponses: { "chat.history": { messages: [{ role: "assistant", content: "linked" }] } },
    pluginFrameGrants: [
      { pluginId: "external-plugin", path: "/plugins/external", match: "prefix" as const },
    ],
  };
}

describeControlUiE2e("PluginPage external capability bridge E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("mounts one opaque capability bridge under the exact Gateway CSP", async () => {
    const page = await createPage();
    await applyGatewayCspToControlUi(page);
    await routeExternalPlugin(page, "<main>exact Gateway CSP fixture</main>");
    const gateway = await installMockGateway(page, bridgeScenario());

    await page.goto(`${server.baseUrl}plugin?plugin=external-plugin&id=panel`);
    const frame = page.locator("openclaw-plugin-page iframe");
    await frame.waitFor();
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(
      await frame
        .contentFrame()
        .locator("html")
        .evaluate(() => location.origin),
    ).toBe("null");

    await expect
      .poll(async () => {
        return await page.evaluate(
          () =>
            (window as Window & { capabilityBootstrapEvents?: string[] })
              .capabilityBootstrapEvents ?? [],
        );
      })
      .toEqual([
        "openclaw:capability-bridge-bootstrap",
        "openclaw:capability-bridge-bootstrap-mounted",
      ]);

    // Keep the fixture document scriptless so the CSP authorizes only the
    // host bootstrap. Playwright supplies the protocol client independently.
    await frame
      .contentFrame()
      .locator("html")
      .evaluate(() => {
        const send = (payload: unknown) =>
          window.postMessage(
            { type: "openclaw:capability-bridge-send", protocolVersion: 1, payload },
            "*",
          );
        window.addEventListener("message", (event) => {
          if (
            event.source !== window ||
            event.data?.type !== "openclaw:capability-bridge-receive" ||
            event.data.protocolVersion !== 1
          ) {
            return;
          }
          const message = event.data.payload;
          if (message?.type === "openclaw:capability-bridge-ready") {
            parent.postMessage({ type: "external-bridge-e2e:ready", value: message }, "*");
            send({
              type: "openclaw:capability-bridge-request",
              requestId: "history-exact-csp",
              method: "chat.history",
              params: { sessionKey: "agent:main:owned", limit: 1 },
            });
          }
        });
        let parentReadable = false;
        try {
          parentReadable = Boolean(parent.document.body);
        } catch {}
        parent.postMessage({ type: "external-bridge-e2e:isolation", parentReadable }, "*");
        send({ type: "openclaw:capability-bridge-hello", protocolVersion: 1 });
      });

    await expect
      .poll(async () => {
        return await page.evaluate(
          () =>
            (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
        );
      })
      .toContainEqual(
        expect.objectContaining({
          type: "external-bridge-e2e:isolation",
          parentReadable: false,
        }),
      );
    await expect
      .poll(async () => {
        return await page.evaluate(
          () =>
            (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
        );
      })
      .toContainEqual(expect.objectContaining({ type: "external-bridge-e2e:ready" }));
    await gateway.waitForRequest("chat.history");
  });

  it("mounts an opaque sandbox, completes the bridge handshake, dispatches a linked read, and revokes on reload", async () => {
    const page = await createPage();
    await routeExternalPlugin(page);
    const gateway = await installMockGateway(page, bridgeScenario());

    await page.goto(`${server.baseUrl}plugin?plugin=external-plugin&id=panel`);
    const frame = page.locator("openclaw-plugin-page iframe");
    await frame.waitFor();
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const sandboxedFrame = frame.contentFrame();
    expect(await sandboxedFrame.locator("html").evaluate(() => location.origin)).toBe("null");
    await expect
      .poll(async () => {
        return await page.evaluate(
          () =>
            (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
        );
      })
      .toContainEqual(
        expect.objectContaining({ type: "external-bridge-e2e:isolation", parentReadable: false }),
      );
    await captureProof(page, "external-bridge-mounted");

    await expect
      .poll(async () => {
        return await page.evaluate(
          () =>
            (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
        );
      })
      .toContainEqual(
        expect.objectContaining({
          type: "external-bridge-e2e:ready",
          relayProtocolVersion: 1,
          value: expect.objectContaining({ methods: ["chat.history"] }),
        }),
      );
    const history = await gateway.waitForRequest("chat.history");
    expect(history.params).toEqual({
      sessionKey: "agent:main:owned",
      limit: 1,
      maxChars: 500_000,
    });
    await expect
      .poll(async () => {
        return await page.evaluate(
          () =>
            (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
        );
      })
      .toContainEqual(
        expect.objectContaining({
          type: "external-bridge-e2e:response",
          value: expect.objectContaining({
            result: { messages: [{ role: "assistant", content: "linked" }] },
          }),
        }),
      );

    await gateway.emitGatewayEvent("config.changed");
    await expect.poll(async () => await gateway.getSocketCount()).toBeGreaterThan(1);
    await expect
      .poll(async () => (await gateway.getRequests("chat.history")).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("keeps a redirect target read-only because it never receives the private channel", async () => {
    const page = await createPage();
    await page.route("**/plugins/external/panel**", async (route) => {
      const url = new URL(route.request().url());
      const nonce = url.searchParams.get("__openclaw_plugin_frame_auth_probe");
      if (nonce) {
        await route.fulfill({
          contentType: "text/html",
          body: `<script>parent.postMessage({type:"openclaw-plugin-frame-auth-probe",nonce:${JSON.stringify(nonce)}},"*")</script>`,
        });
        return;
      }
      await route.fulfill({
        status: 302,
        headers: { location: `${server.baseUrl}redirect-target` },
      });
    });
    await page.route("**/redirect-target", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<script>window.addEventListener("message",event=>{if(event.ports.length)parent.postMessage({type:"external-bridge-e2e:foreign-port"},"*")})</script>`,
      });
    });
    const gateway = await installMockGateway(page, bridgeScenario());

    await page.goto(`${server.baseUrl}plugin?plugin=external-plugin&id=panel`);
    await page.locator("openclaw-plugin-page iframe").waitFor();
    await expect
      .poll(() => page.frames().some((frame) => frame.url().endsWith("/redirect-target")))
      .toBe(true);
    await captureProof(page, "external-bridge-redirect-fallback");
    const events = await page.evaluate(
      () => (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "external-bridge-e2e:foreign-port" }),
    );
    expect(await gateway.getRequests("chat.history")).toEqual([]);
  });

  it("reconciles a plugin write across a real sandbox remount", async () => {
    const page = await createPage();
    await routeExternalPlugin(page, externalPluginMutationDocument());
    const gateway = await installMockGateway(page, bridgeScenario(externalMutationTab));

    await page.goto(`${server.baseUrl}plugin?plugin=external-plugin&id=panel`);
    await gateway.waitForRequest("plugin.example.write");
    expect(await gateway.getRequests("plugin.example.write")).toHaveLength(1);

    await gateway.closeLatest(1012, "test reconnect");
    await expect.poll(async () => await gateway.getSocketCount()).toBeGreaterThan(1);
    await expect
      .poll(async () => {
        const events = await page.evaluate(
          () =>
            (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
        );
        return events.filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            (event as { type?: unknown }).type === "external-bridge-e2e:mutation-ready",
        ).length;
      })
      .toBeGreaterThanOrEqual(2);
    expect(await gateway.getRequests("plugin.example.write")).toHaveLength(1);
  });

  it("refuses an ambiguous plugin write after a real sandbox parent reload", async () => {
    const page = await createPage();
    await routeExternalPlugin(page, externalPluginMutationDocument());
    const gateway = await installMockGateway(page, {
      ...bridgeScenario(externalMutationTab),
      deferredMethods: ["plugin.example.write"],
    });

    await page.goto(`${server.baseUrl}plugin?plugin=external-plugin&id=panel`);
    await gateway.waitForRequest("plugin.example.write");
    expect(await gateway.getRequests("plugin.example.write")).toHaveLength(1);

    await page.reload();
    await expect
      .poll(async () => {
        return await page.evaluate(
          () =>
            (window as Window & { externalBridgeEvents?: unknown[] }).externalBridgeEvents ?? [],
        );
      })
      .toContainEqual(
        expect.objectContaining({
          type: "external-bridge-e2e:mutation-response",
          value: expect.objectContaining({
            error: expect.objectContaining({ code: "MUTATION_RECONCILIATION_REQUIRED" }),
          }),
        }),
      );
    expect(await gateway.getRequests("plugin.example.write")).toEqual([]);
  });
});
