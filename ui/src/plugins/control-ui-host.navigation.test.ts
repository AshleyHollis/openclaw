import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { resolveWorkboardRouteLocation } from "../pages/workboard/route-location.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

function fixture(options: { advertised?: boolean; registered?: boolean } = {}) {
  const abort = new AbortController();
  const targetAbort = new AbortController();
  const navigate = vi.fn();
  const context = {
    basePath: "/console",
    gateway: {
      snapshot: {
        hello: {
          controlUiTabs:
            options.advertised === false
              ? []
              : [{ pluginId: "workboard", id: "workboard", placement: "route:workboard" }],
        },
      },
    },
    navigate,
  } as unknown as ApplicationContext;
  const owner = {
    abort,
    descriptor: { pluginId: "command-center" },
    disposers: new Set(),
  } as Omit<ControlUiPluginOwner, "host">;
  const runtime = {
    isCurrent: (current: Omit<ControlUiPluginOwner, "host">) =>
      current === owner && !abort.signal.aborted,
    registrations: () =>
      options.registered === false
        ? []
        : [{ pluginId: "workboard", value: { id: "workboard" }, signal: targetAbort.signal }],
  } as unknown as ControlUiPluginRuntime;
  return {
    host: createControlUiPluginHost(() => context, runtime, owner),
    navigate,
    abort,
    targetAbort,
  };
}

const target = {
  pluginId: "workboard",
  id: "workboard",
  path: ["approved plans"],
  params: { cardId: "card/exact", tenant: "topic:one" },
};

describe("explicit native plugin page ownership", () => {
  it.each(["other", "__all__"])("retires exact card intent when choosing board %s", (boardId) => {
    const original = window.location.href;
    try {
      window.history.replaceState(
        null,
        "",
        "/console/workboard/ops?p.cardId=card%2Fexact&p.tenant=topic%3Aone&agent=writer",
      );
      const { host } = fixture();
      const href = new URL(
        host.navigation.pageHref(
          {
            pluginId: "workboard",
            id: "workboard",
            path: boardId === "__all__" ? [] : [boardId],
            params: { cardId: null, tenant: null },
          },
          { preserveSearch: true },
        ),
        window.location.origin,
      );
      expect(href.searchParams.get("agent")).toBe("writer");
      expect(href.searchParams.has("p.cardId")).toBe(false);
      expect(href.searchParams.has("p.tenant")).toBe(false);
      const route = resolveWorkboardRouteLocation(
        { pathname: href.pathname, search: href.search, hash: "" },
        "/console",
      );
      expect(route.boardFilter).toBe(boardId);
      expect(route.cardTarget).toBeUndefined();
    } finally {
      window.history.replaceState(null, "", original);
    }
  });
  it("retires the prior tenant for a tenantless exact-card target", () => {
    const original = window.location.href;
    try {
      window.history.replaceState(
        null,
        "",
        "/console/workboard/ops?p.cardId=old&p.tenant=life&agent=writer",
      );
      const { host } = fixture();
      const href = new URL(
        host.navigation.pageHref(
          {
            pluginId: "workboard",
            id: "workboard",
            path: ["default"],
            params: { cardId: "local", tenant: null },
          },
          { preserveSearch: true },
        ),
        window.location.origin,
      );
      expect(href.searchParams.get("agent")).toBe("writer");
      const route = resolveWorkboardRouteLocation(
        { pathname: href.pathname, search: href.search, hash: "" },
        "/console",
      );
      expect(route.boardFilter).toBe("default");
      expect(route.cardTarget).toEqual({ cardId: "local" });
    } finally {
      window.history.replaceState(null, "", original);
    }
  });
  it("opens the advertised active Workboard page from another plugin", () => {
    const { host, navigate } = fixture();
    const href = new URL(host.navigation.pageHref(target), window.location.origin);
    expect(href.pathname).toBe("/console/workboard/approved%20plans");
    expect(href.searchParams.get("p.cardId")).toBe("card/exact");
    expect(href.searchParams.get("p.tenant")).toBe("topic:one");
    host.navigation.openPage(target);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("workboard", {
      route: "workboard",
      pathname: href.pathname,
      search: href.search,
    });
  });

  it.each([{ advertised: false }, { registered: false }])(
    "refuses an unavailable cross-plugin destination (%j)",
    (options) => {
      const { host, navigate } = fixture(options);
      expect(() => host.navigation.pageHref(target)).toThrow("page is unavailable");
      expect(() => host.navigation.openPage(target)).toThrow("page is unavailable");
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("refuses an unadvertised page ID rather than choosing another owner's page", () => {
    const { host, navigate } = fixture();
    expect(() => host.navigation.openPage({ ...target, id: "another" })).toThrow(
      "page is unavailable",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses a destination whose registered page has been retired", () => {
    const { host, targetAbort, navigate } = fixture();
    targetAbort.abort();
    expect(() => host.navigation.openPage(target)).toThrow("page is unavailable");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not retain navigation after the caller's activation ends", () => {
    const { host, abort, navigate } = fixture();
    abort.abort();
    expect(() => host.navigation.openPage(target)).toThrow("activation has ended");
    expect(navigate).not.toHaveBeenCalled();
  });
});
