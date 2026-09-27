/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiBootstrapConfig,
  ControlUiEnvironment,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import "../components/app-topbar.ts";
import "../components/sidebar-agent-card.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createApplicationConfigCapability } from "./config.ts";
import { applyControlUiPresentation } from "./control-ui-environment-presentation.runtime.ts";

const servedFavicon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path id="site-compass" d="M32 8 40 32 32 56 24 32Z"/></svg>';

function isFaviconRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.endsWith("/favicon.svg");
}

type EnvironmentElement = HTMLElement & {
  environment?: ControlUiEnvironment | null;
  subtitle?: string;
  agentName?: string;
  avatarText?: string;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.head.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove());
  document.documentElement.removeAttribute("data-openclaw-environment");
  document.documentElement.style.removeProperty("--control-ui-environment-color");
  document.documentElement.style.removeProperty("--control-ui-environment-ink");
  document.documentElement.style.removeProperty("--control-ui-environment-amber");
  document.documentElement.style.removeProperty("--ring");
  document.documentElement.style.removeProperty("--accent");
});

describe("Control UI environment presentation", () => {
  setupSidebarTest();

  it("keeps the served favicon artwork when an environment is configured", async () => {
    const favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    favicon.href = "/favicon.svg";
    document.head.append(favicon);
    document.documentElement.style.setProperty("--control-ui-environment-amber", "#f59e0b");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(servedFavicon)),
    );

    applyControlUiPresentation({ environment: { label: "Life", color: "amber" } });

    await vi.waitFor(() => {
      expect(decodeURIComponent(favicon.href)).toContain('id="site-compass"');
      expect(decodeURIComponent(favicon.href)).not.toContain('d="M60 10C30');
    });
    applyControlUiPresentation({ environment: null });
  });

  it("renders a matching stripe, favicon, avatar ring, and sidebar/topbar pills only when configured", async () => {
    const favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    favicon.href = "/favicon.svg";
    document.head.append(favicon);
    document.documentElement.style.setProperty("--control-ui-environment-amber", "#f59e0b");

    const sidebar = document.createElement("openclaw-sidebar-agent-card") as EnvironmentElement;
    sidebar.agentName = "OpenClaw";
    sidebar.avatarText = "O";
    sidebar.subtitle = "Assistant";
    const topbar = document.createElement("openclaw-app-topbar") as EnvironmentElement;
    document.body.append(sidebar, topbar);
    await Promise.all([sidebar.updateComplete, topbar.updateComplete]);

    expect(document.querySelector(".control-ui-environment-stripe")).toBeNull();
    expect(document.querySelector(".control-ui-environment-pill")).toBeNull();
    expect(favicon.getAttribute("href")).toBe("/favicon.svg");

    const environment = { label: "edge", color: "amber" } as const;
    const payload: ControlUiBootstrapConfig = {
      basePath: "",
      assistantName: "OpenClaw",
      assistantAvatar: "O",
      environment,
      seamColor: "#123456",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(isFaviconRequest(input) ? servedFavicon : JSON.stringify(payload)),
      ),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    await config.refresh();
    await vi.dynamicImportSettled();
    sidebar.environment = config.current.environment;
    topbar.environment = config.current.environment;
    await Promise.all([sidebar.updateComplete, topbar.updateComplete]);

    expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue("--control-ui-environment-color")).toBe(
      "var(--control-ui-environment-amber)",
    );
    expect(document.documentElement.style.getPropertyValue("--ring")).toBe("#123456");
    expect(sidebar.querySelector(".control-ui-environment-pill")?.textContent).toBe("edge");
    expect(sidebar.querySelector(".sidebar-agent-card__avatar--environment")).not.toBeNull();
    expect(topbar.querySelector(".control-ui-environment-pill")?.textContent).toBe("edge");
    await vi.waitFor(() => expect(favicon.href).toContain("data:image/svg+xml,"));
    expect(decodeURIComponent(favicon.href)).toContain('id="site-compass"');
    expect(decodeURIComponent(favicon.href)).toContain("#f59e0b");
  });

  it("clears environment presentation when a configured bootstrap refresh becomes unset", async () => {
    document.title = "OpenClaw Control";
    document.documentElement.style.setProperty("--control-ui-environment-amber", "#f59e0b");

    const svgFavicon = document.createElement("link");
    svgFavicon.rel = "icon";
    svgFavicon.setAttribute("href", "/favicon.svg");
    svgFavicon.setAttribute("type", "image/svg+xml");
    document.head.append(svgFavicon);

    const bootstrap: ControlUiBootstrapConfig = {
      basePath: "",
      assistantName: "OpenClaw",
      assistantAvatar: "O",
    };
    let bootstrapReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (isFaviconRequest(input)) {
          return new Response(servedFavicon);
        }
        return new Response(
          JSON.stringify(
            bootstrapReads++ === 0
              ? { ...bootstrap, environment: { label: "edge", color: "amber" } }
              : bootstrap,
          ),
        );
      }),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    await config.refresh();
    await vi.dynamicImportSettled();

    expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
    await vi.waitFor(() =>
      expect(svgFavicon.getAttribute("href")).toContain("data:image/svg+xml,"),
    );
    expect(decodeURIComponent(svgFavicon.href)).toContain('id="site-compass"');
    expect(document.title).toBe("OpenClaw Control · edge");
    expect(document.documentElement.hasAttribute("data-openclaw-environment")).toBe(true);

    await config.refresh();
    await vi.dynamicImportSettled();

    expect(config.current.environment).toBeNull();
    expect(document.querySelector(".control-ui-environment-stripe")).toBeNull();
    expect(svgFavicon.getAttribute("href")).toBe("/favicon.svg");
    expect(svgFavicon.getAttribute("type")).toBe("image/svg+xml");
    expect(document.documentElement.style.getPropertyValue("--control-ui-environment-color")).toBe(
      "",
    );
    expect(document.documentElement.style.getPropertyValue("--control-ui-environment-ink")).toBe(
      "",
    );
    expect(document.title).toBe("OpenClaw Control");
    expect(document.documentElement.hasAttribute("data-openclaw-environment")).toBe(false);
  });

  it("clears seam-color presentation when a seam-only bootstrap refresh becomes unset", async () => {
    const bootstrap: ControlUiBootstrapConfig = {
      basePath: "",
      assistantName: "OpenClaw",
      assistantAvatar: "O",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...bootstrap, seamColor: "#123456" })))
        .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap))),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    await config.refresh();
    await vi.dynamicImportSettled();

    expect(document.documentElement.style.getPropertyValue("--ring")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");

    await config.refresh();
    await vi.dynamicImportSettled();

    for (const property of [
      "--ring",
      "--accent",
      "--accent-hover",
      "--accent-muted",
      "--accent-subtle",
      "--accent-glow",
      "--primary",
      "--focus",
      "--focus-ring",
      "--focus-glow",
    ]) {
      expect(document.documentElement.style.getPropertyValue(property)).toBe("");
    }
  });

  it("applies public document environment metadata before authenticated bootstrap", async () => {
    document.documentElement.setAttribute(
      "data-openclaw-environment",
      JSON.stringify({ label: "team", color: "amber" }),
    );
    document.title = "OpenClaw Control";

    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    await vi.dynamicImportSettled();

    expect(config.current.environment).toEqual({ label: "team", color: "amber" });
    expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
    expect(document.title).toBe("OpenClaw Control · team");
  });
});
