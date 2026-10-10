/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { renderSidebarReorderMenu } from "./sidebar-reorder.ts";

// The renderer owns identity/focus; native synchronous selection is driven explicitly.
vi.mock("./web-awesome.ts", () => ({}));

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(html``, container);
    container.remove();
  }
});

describe("sidebar reorder focus ownership", () => {
  it("retires a selection when its row is disconnected before native dispatch completes", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    containers.push(container);
    const onMove = vi.fn();
    render(
      html`<div data-sidebar-entry="first"></div>
        <div data-sidebar-entry="second">
          ${renderSidebarReorderMenu({ label: "second", kind: "entry", onMove })}
        </div>`,
      container,
    );
    const menu = container.querySelector<HTMLElement>("wa-dropdown")!;
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "before" } } }));
    container.remove();
    await Promise.resolve();
    expect(onMove).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "joins native selection and move, preserving newer outside focus=%s",
    async (outsideFocus) => {
      const container = document.body.appendChild(document.createElement("div"));
      containers.push(container);
      const moved = createDeferred();
      const started = createDeferred();
      let order = ["birdclaw", "workboard"];
      const draw = (): void => {
        render(
          html`
            <button class="outside">Another control</button>
            <div class="rows">
              ${order.map(
                (key) => html`<div data-sidebar-entry=${key}>
                  ${renderSidebarReorderMenu({
                    label: key,
                    kind: "entry",
                    onMove,
                  })}
                </div>`,
              )}
            </div>
          `,
          container,
        );
      };
      const onMove = vi.fn(async () => {
        order = ["workboard", "birdclaw"];
        draw();
        started.resolve();
        await moved.promise;
      });
      draw();
      const row = container.querySelector('[data-sidebar-entry="workboard"]')!;
      const menu = row.querySelector<HTMLElement>("wa-dropdown")!;
      const original = menu.querySelector<HTMLButtonElement>("button")!;
      const outside = container.querySelector<HTMLButtonElement>(".outside")!;
      Reflect.set(menu, "open", true);
      original.focus();
      menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "before" } } }));
      expect(onMove).not.toHaveBeenCalled();
      // Native selection restores its captured trigger before returning from dispatch.
      original.focus();
      Reflect.set(menu, "open", false);
      await started.promise;
      expect(onMove).toHaveBeenCalledExactlyOnceWith("birdclaw", "before");
      const current = container.querySelector<HTMLButtonElement>(
        '[data-sidebar-entry="workboard"] .sidebar-reorder-trigger',
      )!;
      expect(current).not.toBe(original);
      expect(original.closest("[data-sidebar-entry]")?.getAttribute("data-sidebar-entry")).toBe(
        "birdclaw",
      );
      expect(document.activeElement).toBe(original);
      if (outsideFocus) {
        outside.focus();
      }
      moved.resolve();
      await moved.promise;
      await Promise.resolve();
      expect(document.activeElement).toBe(outsideFocus ? outside : current);
    },
  );
});
