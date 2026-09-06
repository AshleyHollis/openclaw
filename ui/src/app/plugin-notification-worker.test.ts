import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

function fixture() {
  type Push = { data: { json(): unknown }; waitUntil(value: Promise<unknown>): void };
  const listeners = new Map<string, (event: Push) => void>();
  const close = vi.fn();
  const registration = {
    scope: "https://control.example/openclaw/",
    showNotification: vi.fn(async () => {}),
    getNotifications: vi.fn(async () => [{ close }]),
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public/sw.js"),
      "utf8",
    ),
    {
      URL,
      self: {
        location: { href: "https://control.example/openclaw/sw.js" },
        registration,
        addEventListener: (type: string, fn: (event: Push) => void) => listeners.set(type, fn),
      },
    },
  );
  const push = (kind: string, expiresAtMs = Date.now() + 60_000) => {
    let promise = Promise.resolve<unknown>(undefined);
    listeners.get("push")?.({
      data: {
        json: () => ({
          title: "Example",
          tag: "operation-1",
          notification: { version: 1, kind, expiresAtMs },
        }),
      },
      waitUntil: (value) => {
        promise = value;
      },
    });
    return promise;
  };
  return { registration, close, push };
}

describe("plugin notification worker ordering", () => {
  it("waits for an earlier show before closing exactly its tag", async () => {
    const f = fixture();
    const shown = createDeferred<void>();
    f.registration.showNotification.mockImplementationOnce(() => shown.promise);
    const notify = f.push("notify");
    const clear = f.push("clear", Date.now());
    await Promise.resolve();
    expect(f.close).not.toHaveBeenCalled();
    shown.resolve();
    await Promise.all([notify, clear]);
    expect(f.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(f.registration.getNotifications).toHaveBeenCalledWith({ tag: "operation-1" });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("rejects expired and unknown plugin envelopes without showing generic alerts", async () => {
    const f = fixture();
    await f.push("notify", Date.now() - 1);
    await f.push("unknown");
    expect(f.registration.showNotification).not.toHaveBeenCalled();
  });
  it("keeps later clear operations runnable after a failed show", async () => {
    const f = fixture();
    f.registration.showNotification.mockRejectedValueOnce(new Error("display unavailable"));
    await expect(f.push("notify")).rejects.toThrow("display unavailable");
    await f.push("clear");
    expect(f.close).toHaveBeenCalledOnce();
  });
});
