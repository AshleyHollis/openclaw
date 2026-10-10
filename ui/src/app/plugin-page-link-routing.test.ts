/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "./context.ts";
import { startPluginPageLinkRouting } from "./plugin-page-link-routing.ts";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../lib/toast.ts", () => ({ showToast }));
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function fixture() {
  let connected = true,
    canRead = true;
  const abort = new AbortController();
  const openPage = vi.fn<(target: { id: string; params: Record<string, string> }) => void>();
  const pageHref = vi.fn((target: { id: string; params: Record<string, string> }) => {
    const params = new URLSearchParams({ plugin: "fictional", id: target.id });
    for (const [key, value] of Object.entries(target.params)) {
      params.set(`p.${key}`, value);
    }
    return `/console/plugin?${params}`;
  });
  const entry = {
    pluginId: "fictional",
    value: { id: "notes" },
    signal: abort.signal,
    host: {
      get connection() {
        return { connected, canRead };
      },
      navigation: { openPage, pageHref },
    },
  };
  let entries = [entry];
  const context = {
    basePath: "/console",
    plugins: { registrations: () => entries },
  } as unknown as ApplicationContext;
  const routing = startPluginPageLinkRouting(() => context);
  stops.push(routing.dispose);
  document.body.innerHTML =
    '<openclaw-app-shell><a href="/console/plugin?plugin=fictional&id=notes&p.path=shared%2Fone.md&p.revision=sha%3Aexact">Source</a></openclaw-app-shell>';
  const anchor = document.querySelector("a")!;
  const click = (options: MouseEventInit = {}) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
    let handled = false;
    // Observe the product decision before suppressing jsdom's default navigation.
    window.addEventListener(
      "click",
      (observedEvent) => {
        handled = observedEvent.defaultPrevented;
        observedEvent.preventDefault();
      },
      { once: true },
    );
    anchor.dispatchEvent(event);
    return handled;
  };
  return {
    anchor,
    click,
    openPage,
    pageHref,
    abort,
    routing,
    offline: () => {
      connected = false;
    },
    denyRead: () => {
      canRead = false;
    },
    unregister: () => {
      entries = [];
    },
    duplicate: () => {
      entries = [entry, entry];
    },
  };
}

describe("registered plugin-page links", () => {
  it("uses the current same-plugin owner without inventing an advertised tab or inheriting search", () => {
    const f = fixture();
    expect(f.click()).toBe(true);
    expect(f.openPage).toHaveBeenCalledExactlyOnceWith({
      id: "notes",
      params: { path: "shared/one.md", revision: "sha:exact" },
    });
    expect(showToast).not.toHaveBeenCalled();
  });
  it.each(["offline", "denyRead", "unregister", "duplicate"] as const)(
    "retains the document and reports unavailable after %s",
    (change) => {
      const f = fixture();
      f[change]();
      expect(f.click()).toBe(true);
      expect(f.openPage).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledOnce();
    },
  );
  it("rejects a retired owner across href resolution before dispatch", () => {
    const f = fixture();
    f.pageHref.mockImplementationOnce(() => {
      f.abort.abort();
      return f.anchor.href;
    });
    expect(f.click()).toBe(true);
    expect(f.openPage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledOnce();
  });
  it("does not convert host failure or a route mismatch into document navigation", () => {
    const f = fixture();
    f.pageHref.mockReturnValueOnce("/console/settings");
    expect(f.click()).toBe(true);
    expect(f.openPage).not.toHaveBeenCalled();
    f.openPage.mockImplementationOnce(() => {
      throw new Error("fictional owner retired");
    });
    expect(f.click()).toBe(true);
    expect(showToast).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])("preserves modified/native click behavior %j", (options) => {
    const f = fixture();
    expect(f.click(options)).toBe(false);
    expect(f.openPage).not.toHaveBeenCalled();
  });
  it.each(["target", "download", "data-file-path", "data-link-reader-external"])(
    "leaves %s links to their owner",
    (attribute) => {
      const f = fixture();
      f.anchor.setAttribute(attribute, attribute === "target" ? "_blank" : "fictional");
      expect(f.click()).toBe(false);
      expect(f.openPage).not.toHaveBeenCalled();
    },
  );
  it.each([
    "https://example.invalid/console/plugin?plugin=fictional&id=notes",
    "/plugin?plugin=fictional&id=notes",
    "/console/settings",
    "http://[",
  ])("does not claim foreign/out-of-scope URL %s", (href) => {
    const f = fixture();
    f.anchor.href = href;
    expect(f.click()).toBe(false);
    expect(f.openPage).not.toHaveBeenCalled();
  });
  it("respects prior interception and disposes its document listener", () => {
    const f = fixture();
    f.anchor.addEventListener("click", (event) => event.preventDefault(), { once: true });
    expect(f.click()).toBe(true);
    expect(f.openPage).not.toHaveBeenCalled();
    f.routing.dispose();
    expect(f.click()).toBe(false);
    expect(f.openPage).not.toHaveBeenCalled();
  });
  it.each([
    "plugin=fictional&plugin=fictional&id=notes",
    "plugin=fictional&id=notes&id=notes",
    "plugin=fictional&id=notes&p.path=one&p.path=two",
    "plugin=fictional&id=notes&token=fictional",
    "plugin=fictional&id=notes&__openclawPluginPath=other",
    "plugin=fictional&id=notes&p.=empty",
    "plugin=&id=notes",
  ])("rejects ambiguous/unsupported parameters %s", (search) => {
    const f = fixture();
    f.anchor.search = search;
    expect(f.click()).toBe(true);
    expect(f.openPage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledOnce();
  });
  it.each(["fragment", "userinfo"] as const)("rejects %s on a same-app plugin link", (kind) => {
    const f = fixture();
    const url = new URL(f.anchor.href);
    if (kind === "fragment") {
      url.hash = "fragment";
    } else {
      url.username = "fictional";
      url.password = "fictional";
    }
    f.anchor.href = url.href;
    expect(f.click()).toBe(true);
    expect(f.openPage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledOnce();
  });
  it("preserves exact opaque values and safely represents prototype-shaped page keys", () => {
    const f = fixture();
    f.anchor.search = "plugin=fictional&id=notes&p.__proto__=exact&p.path=+odd%2Fname+&p.revision=";
    expect(f.click()).toBe(true);
    const target = f.openPage.mock.calls[0]?.[0];
    expect(Object.getPrototypeOf(target?.params ?? {})).toBe(null);
    expect(target?.params).toMatchObject({ path: " odd/name ", revision: "" });
    expect(Reflect.get(target?.params ?? {}, "__proto__")).toBe("exact");
  });
});
