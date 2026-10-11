import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createConfigResolutionFacts,
  getConfigResolutionFacts,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
  loadPinnedRuntimeConfigAsync,
  registerRuntimeConfigSnapshotPreparer,
  resetConfigRuntimeState,
  type RuntimeConfigSnapshotPreparationContext,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
  withRuntimeConfigSessionStoreSelection,
} from "./runtime-snapshot.js";
import { withRuntimeConfigSessionStoreSelectionAsync } from "./runtime-snapshot.test-support.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "./runtime-source-projection.js";
import type { OpenClawConfig } from "./types.js";

const unregister: Array<() => void> = [];

afterEach(() => {
  unregister.splice(0).forEach((release) => release());
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

function gatedPreparer() {
  const started = createDeferredCore();
  const deferred = createDeferredCore<() => void>();
  const syncPrepare = vi.fn();
  const prepareAsync = vi.fn(
    (_config: OpenClawConfig, _context: RuntimeConfigSnapshotPreparationContext) => {
      started.resolve();
      return deferred.promise;
    },
  );
  const release = registerRuntimeConfigSnapshotPreparer(syncPrepare, { prepareAsync });
  unregister.push(release);
  return { started: started.promise, deferred, syncPrepare, prepareAsync, release };
}

describe("prepared runtime snapshots", () => {
  it("keeps registration and setters synchronous when an async companion is available", () => {
    const active: OpenClawConfig = { gateway: { port: 18789 } };
    setRuntimeConfigSnapshot(active);
    const prepare = vi.fn();
    const prepareAsync = vi.fn(async () => () => {});
    unregister.push(registerRuntimeConfigSnapshotPreparer(prepare, { prepareAsync }));
    expect(prepare).toHaveBeenCalledExactlyOnceWith(active);
    const next: OpenClawConfig = { gateway: { port: 19001 } };
    expect(setRuntimeConfigSnapshot(next)).toBeUndefined();
    expect(prepare).toHaveBeenLastCalledWith(next);
    expect(getRuntimeConfigSnapshot()).toBe(next);
    expect(prepareAsync).not.toHaveBeenCalled();
  });

  it("rejects a preparer's changed selection before it can publish", () => {
    const active: OpenClawConfig = { session: { store: "/fixture/one" } };
    setRuntimeConfigSnapshot(active);
    unregister.push(
      registerRuntimeConfigSnapshotPreparer((candidate) => {
        if (candidate !== active) {
          candidate.session = { store: "/fixture/two" };
        }
      }),
    );
    withRuntimeConfigSessionStoreSelection(() => {
      expect(() => setRuntimeConfigSnapshot({ session: { store: "/fixture/one" } })).toThrow(
        "session.store selection cannot change",
      );
      expect(getRuntimeConfigSnapshot()).toBe(active);
    });
  });

  it("rejects reentrant preparer selection changes during an awaited admission", async () => {
    const active: OpenClawConfig = { session: { store: "/fixture/one" } };
    setRuntimeConfigSnapshot(active);
    unregister.push(
      registerRuntimeConfigSnapshotPreparer((candidate) => {
        if (candidate !== active && candidate.session?.store === "/fixture/one") {
          setRuntimeConfigSnapshot({ session: { store: "/fixture/two" } });
        }
      }),
    );
    const release = createDeferredCore();
    const operation = withRuntimeConfigSessionStoreSelectionAsync(() => release.promise);
    expect(() => setRuntimeConfigSnapshot({ session: { store: "/fixture/one" } })).toThrow(
      "session.store selection cannot change",
    );
    expect(getRuntimeConfigSnapshot()).toBe(active);
    release.resolve();
    await operation;
    setRuntimeConfigSnapshot({ session: { store: "/fixture/two" } });
    expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/two");
  });

  it("keeps the active selection when source publication passes it to a mutating preparer", () => {
    const active: OpenClawConfig = { session: { store: "/fixture/one" } };
    setRuntimeConfigSnapshot(active);
    let mutate = false;
    unregister.push(
      registerRuntimeConfigSnapshotPreparer((config) => {
        if (mutate) {
          config.session = { store: "/fixture/two" };
        }
      }),
    );
    const revision = getRuntimeConfigSnapshotMetadata()?.revision;
    if (revision === undefined) {
      throw new Error("Expected an active runtime config revision");
    }
    withRuntimeConfigSessionStoreSelection(() => {
      mutate = true;
      try {
        expect(() =>
          setRuntimeConfigSourceSnapshotIfCurrent({
            expectedRevision: revision,
            sourceConfig: { session: { store: "/fixture/one" } },
          }),
        ).toThrow("session.store selection cannot change");
      } finally {
        mutate = false;
      }
      expect(getRuntimeConfigSnapshot()).toBe(active);
      expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/one");
    });
    expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/one");
  });

  it("keeps the active selection when registering a mutating preparer during admission", () => {
    const active: OpenClawConfig = { session: { store: "/fixture/one" } };
    setRuntimeConfigSnapshot(active);
    let mutate = true;
    let release: (() => void) | undefined;
    try {
      withRuntimeConfigSessionStoreSelection(() => {
        try {
          release = registerRuntimeConfigSnapshotPreparer((config) => {
            if (mutate) {
              config.session = { store: "/fixture/two" };
            }
          });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("session.store selection cannot change");
        }
        expect(getRuntimeConfigSnapshot()).toBe(active);
        expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/one");
      });
      expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/one");
      mutate = false;
      setRuntimeConfigSnapshot({ session: { store: "/fixture/three" } });
      expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/three");
    } finally {
      mutate = false;
      release?.();
    }
  });

  it("rejects a candidate sharing the active session selector before its preparer mutates it", () => {
    const active: OpenClawConfig = { session: { store: "/fixture/one" } };
    setRuntimeConfigSnapshot(active);
    unregister.push(
      registerRuntimeConfigSnapshotPreparer((config) => {
        if (config !== active && config.session) {
          config.session.store = "/fixture/two";
        }
      }),
    );
    const candidate: OpenClawConfig = { ...active };
    withRuntimeConfigSessionStoreSelection(() => {
      expect(() => setRuntimeConfigSnapshot(candidate)).toThrow(
        "session.store selection cannot change",
      );
      expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/one");
    });
    expect(active.session?.store).toBe("/fixture/one");
    setRuntimeConfigSnapshot(candidate);
    expect(getRuntimeConfigSnapshot()).toBe(candidate);
    expect(getRuntimeConfigSnapshot()?.session?.store).toBe("/fixture/two");
  });

  it("does not retain a preparer when its initial active preparation throws", () => {
    setRuntimeConfigSnapshot({ session: { store: "/fixture/one" } });
    expect(() =>
      registerRuntimeConfigSnapshotPreparer(() => {
        throw new Error("preparer failed");
      }),
    ).toThrow("preparer failed");
    const next: OpenClawConfig = { session: { store: "/fixture/two" } };
    setRuntimeConfigSnapshot(next);
    expect(getRuntimeConfigSnapshot()).toBe(next);
  });

  it("holds a selected store during a prepared contribution's reentrant publication", async () => {
    const active: OpenClawConfig = { session: { store: "/fixture/one" } };
    const candidate: OpenClawConfig = { session: { store: "/fixture/two" } };
    unregister.push(
      registerRuntimeConfigSnapshotPreparer(() => {}, {
        prepareAsync: async () => () => {
          setRuntimeConfigSnapshot(active);
          withRuntimeConfigSessionStoreSelection(() => {
            expect(() => setRuntimeConfigSnapshot(candidate)).toThrow(
              "session.store selection cannot change",
            );
            expect(getRuntimeConfigSnapshot()).toBe(active);
          });
        },
      }),
    );
    expect(await loadPinnedRuntimeConfigAsync(async () => ({ config: candidate }))).toBe(active);
    expect(getRuntimeConfigSnapshot()).toBe(active);
  });

  it("prepares registrations added during a cold load before publishing and reusing its config", async () => {
    const changes = vi.fn(() => getRuntimeConfigSnapshot());
    unregister.push(sessionChanges.subscribe(changes));
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const facts = createConfigResolutionFacts([]);
    setConfigResolutionFacts(candidate, facts);
    const loadGate = createDeferredCore<{ config: OpenClawConfig }>();
    const pending = loadPinnedRuntimeConfigAsync(() => loadGate.promise);
    const { started, deferred, syncPrepare, prepareAsync } = gatedPreparer();
    const contribute = vi.fn(() => {
      expect(getRuntimeConfigSnapshot()).toBeNull();
      expect(getConfigResolutionFacts(candidate)).toBe(facts);
    });
    const legacyPrepare = vi.fn();
    unregister.push(registerRuntimeConfigSnapshotPreparer(legacyPrepare));
    loadGate.resolve({ config: candidate });
    await started;
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
    expect(contribute).not.toHaveBeenCalled();
    expect(legacyPrepare).not.toHaveBeenCalled();
    deferred.resolve(contribute);
    expect(await pending).toBe(candidate);
    expect(getRuntimeConfigSnapshot()).toBe(candidate);
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(1);
    expect(syncPrepare).not.toHaveBeenCalled();
    expect(prepareAsync).toHaveBeenCalledExactlyOnceWith(candidate, { env: undefined });
    expect(legacyPrepare).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(contribute).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    expect(changes).toHaveReturnedWith(candidate);
    const load = vi.fn(async () => ({ config: {} }));
    expect(await loadPinnedRuntimeConfigAsync(load)).toBe(candidate);
    expect(load).not.toHaveBeenCalled();
  });

  const modelConfig = (model = "unit-test/model"): OpenClawConfig => ({
    agents: {
      defaults: { model },
      entries: { main: { identity: { name: "Zilla" } } },
    },
  });

  const tokenConfig = (): OpenClawConfig => ({
    gateway: { port: 18789, auth: { token: "unit-test-token" } },
  });
  const withTokenFacts = (config: OpenClawConfig, unresolvedPaths: string[]): OpenClawConfig => {
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        unresolvedPaths.map((configPath) => ({ varName: "UNIT_TEST_TOKEN", configPath })),
      ),
    );
    return config;
  };

  it.each([
    {
      name: "withholds an equal reload, then invalidates a changed model",
      initial: () => modelConfig(),
      next: () => modelConfig(),
      followup: () => modelConfig("unit-test/other"),
      emits: false,
    },
    {
      name: "withholds a distinct object with equal values and equal fresh provenance",
      next: () => withTokenFacts(tokenConfig(), ["gateway.auth.token"]),
      emits: false,
    },
    {
      name: "invalidates the published object republished without an edit",
      next: (published: OpenClawConfig) => published,
      emits: true,
    },
    {
      name: "invalidates equal bytes whose resolution provenance changed",
      next: () => withTokenFacts(tokenConfig(), []),
      emits: true,
    },
    {
      name: "invalidates equal bytes that lost their resolution provenance",
      next: () => tokenConfig(),
      emits: true,
    },
    {
      name: "invalidates a distinct object matching values edited in place on the published one",
      next: (published: OpenClawConfig) => {
        published.gateway = { ...published.gateway, port: 19001 };
        return withTokenFacts({ gateway: { ...tokenConfig().gateway, port: 19001 } }, [
          "gateway.auth.token",
        ]);
      },
      emits: true,
    },
    {
      name: "invalidates a distinct object matching provenance changed in place on the published one",
      next: (published: OpenClawConfig) => {
        setConfigResolutionFacts(published, createConfigResolutionFacts([]));
        return withTokenFacts(tokenConfig(), []);
      },
      emits: true,
    },
  ])("$name", ({ initial, next, followup, emits }) => {
    const changes = vi.fn();
    unregister.push(sessionChanges.subscribe(changes));
    const published = initial?.() ?? withTokenFacts(tokenConfig(), ["gateway.auth.token"]);
    setRuntimeConfigSnapshot(published);
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    changes.mockClear();

    setRuntimeConfigSnapshot(next(published));
    expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(2);
    expect(changes).toHaveBeenCalledTimes(emits ? 1 : 0);
    if (emits) {
      expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    }
    if (followup) {
      setRuntimeConfigSnapshot(followup());
      expect(getRuntimeConfigSnapshotMetadata()?.revision).toBe(3);
      expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    }
  });

  it("withholds a source-only republish only when runtime values and provenance are unchanged", () => {
    const changes = vi.fn();
    unregister.push(sessionChanges.subscribe(changes));
    const runtime: OpenClawConfig = { gateway: { port: 18789 } };
    const source = (version: string, unresolvedPaths: string[] = []): OpenClawConfig =>
      withTokenFacts(
        { gateway: { port: 18789 }, meta: { lastTouchedVersion: version } },
        unresolvedPaths,
      );
    const advance = (sourceConfig: OpenClawConfig) => {
      changes.mockClear();
      expect(
        setRuntimeConfigSourceSnapshotIfCurrent({
          expectedRevision: getRuntimeConfigSnapshotMetadata()?.revision ?? 0,
          sourceConfig,
        }),
      ).toBe(true);
      expect(getRuntimeConfigSourceSnapshot()).toBe(sourceConfig);
      return changes.mock.calls.length;
    };
    setRuntimeConfigSnapshot(runtime, source("1"));

    // A value-identical config.apply only restamps the source's meta, so no row can change.
    expect(advance(source("2"))).toBe(0);
    // Changed provenance is copied onto the published object in place, so rows refresh.
    expect(advance(source("3", ["gateway.port"]))).toBe(1);
    // So does an in-place edit of the published object made since its last publication.
    runtime.gateway = { port: 19001 };
    expect(advance(source("4", ["gateway.port"]))).toBe(1);
    // And provenance changed in place, even when the newer source carries the same facts.
    setConfigResolutionFacts(runtime, createConfigResolutionFacts([]));
    expect(advance(source("5"))).toBe(1);
    expect(getRuntimeConfigSnapshot()).toBe(runtime);
  });

  it.each([
    "publication",
    "reset without active snapshot",
    "registration",
    "unregistration",
    "candidate bytes",
    "candidate facts",
    "environment",
    "caller",
  ])("discards a cold candidate after %s changes during preparation", async (change) => {
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const { started, deferred, release, prepareAsync } = gatedPreparer();
    const contribute = vi.fn();
    const env = { OPENCLAW_STATE_DIR: "/fixture/prepared-state" };
    const rollback = Object.assign(vi.fn(), { commit: vi.fn() });
    const publish = vi.fn(() => rollback);
    let current = true;
    const runtimeEnv =
      change === "environment" || change === "caller" ? { env, publish } : undefined;
    const pending = loadPinnedRuntimeConfigAsync(
      async () => ({ config: candidate, runtimeEnv }),
      change === "caller"
        ? {
            assertCurrent: () => {
              if (!current) {
                throw new Error("caller superseded");
              }
            },
          }
        : undefined,
    );
    await started;
    if (runtimeEnv) {
      expect(prepareAsync).toHaveBeenCalledExactlyOnceWith(candidate, { env });
      expect(prepareAsync.mock.calls[0]?.[1].env).toBe(env);
    }
    switch (change) {
      case "publication":
        setRuntimeConfigSnapshot({ gateway: { port: 20000 } });
        break;
      case "reset without active snapshot":
        resetConfigRuntimeState();
        break;
      case "registration":
        unregister.push(registerRuntimeConfigSnapshotPreparer(() => {}));
        break;
      case "unregistration":
        release();
        break;
      case "candidate bytes":
        candidate.gateway = { port: 20000 };
        break;
      case "candidate facts":
        setConfigResolutionFacts(candidate, createConfigResolutionFacts([]));
        break;
      case "environment":
        env.OPENCLAW_STATE_DIR = "/fixture/replaced-state";
        break;
      case "caller":
        current = false;
        break;
    }
    const active = getRuntimeConfigSnapshot();
    const metadata = getRuntimeConfigSnapshotMetadata();
    const result = active
      ? expect(pending).resolves.toBe(active)
      : expect(pending).rejects.toThrow(change === "caller" ? "caller superseded" : "superseded");
    deferred.resolve(contribute);
    await result;
    expect(contribute).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBe(active);
    expect(getRuntimeConfigSnapshotMetadata()).toBe(metadata);
    expect(rollback).toHaveBeenCalledTimes(change === "environment" ? 1 : 0);
    expect(rollback.commit).not.toHaveBeenCalled();
    if (change === "caller") {
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it("joins rejected preparation companions before failing the cold load", async () => {
    const { started, deferred, syncPrepare } = gatedPreparer();
    const remaining = createDeferredCore<() => void>();
    const contribute = vi.fn();
    unregister.push(
      registerRuntimeConfigSnapshotPreparer(() => {}, {
        prepareAsync: () => remaining.promise,
      }),
    );
    const pending = loadPinnedRuntimeConfigAsync(async () => ({
      config: { gateway: { port: 19001 } },
    }));
    const completed = vi.fn();
    const observed = pending.then(completed, completed);
    await started;
    deferred.reject(new Error("preparation failed"));
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    remaining.resolve(contribute);
    await expect(pending).rejects.toThrow("preparation failed");
    await observed;
    expect(completed).toHaveBeenCalledOnce();
    expect(contribute).not.toHaveBeenCalled();
    expect(syncPrepare).not.toHaveBeenCalled();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSnapshotMetadata()).toBeNull();
  });
});

describe("async cold runtime pin", () => {
  it.each(["reset", "newer publication"])("discards a cold load after %s", async (change) => {
    const gate = createDeferredCore<{ config: OpenClawConfig }>();
    const pending = loadPinnedRuntimeConfigAsync(() => gate.promise);
    const candidate: OpenClawConfig = { gateway: { port: 19001 } };
    const current: OpenClawConfig = { gateway: { port: 20001 } };
    if (change === "reset") {
      resetConfigRuntimeState();
      const rejected = expect(pending).rejects.toThrow("superseded");
      gate.resolve({ config: candidate });
      await rejected;
      expect(getRuntimeConfigSnapshot()).toBeNull();
    } else {
      setRuntimeConfigSnapshot(current);
      gate.resolve({ config: candidate });
      expect(await pending).toBe(current);
      expect(getRuntimeConfigSnapshot()).toBe(current);
    }
  });

  it.each(["publication", "reset", "admission"] as const)(
    "does not publish a cold candidate superseded by a contribution's %s",
    async (change) => {
      const candidate: OpenClawConfig = { gateway: { port: 19001 } };
      const newer: OpenClawConfig = { gateway: { port: 20001 } };
      let admitted = true;
      const rollback = Object.assign(vi.fn(), { commit: vi.fn() });
      unregister.push(
        registerRuntimeConfigSnapshotPreparer(() => {}, {
          prepareAsync: async () => () => {
            if (change === "publication") {
              setRuntimeConfigSnapshot(newer);
            } else if (change === "reset") {
              resetConfigRuntimeState();
            } else {
              admitted = false;
            }
          },
        }),
      );
      const pending = loadPinnedRuntimeConfigAsync(
        async () => ({ config: candidate, runtimeEnv: { env: {}, publish: () => rollback } }),
        {
          assertCurrent: () => {
            if (!admitted) {
              throw new Error("caller superseded during contribution");
            }
          },
        },
      );
      if (change === "publication") {
        expect(await pending).toBe(newer);
        expect(getRuntimeConfigSnapshot()).toBe(newer);
      } else {
        await expect(pending).rejects.toThrow("superseded");
        expect(getRuntimeConfigSnapshot()).toBeNull();
      }
      expect(rollback).toHaveBeenCalledOnce();
      expect(rollback.commit).not.toHaveBeenCalled();
    },
  );
});

describe("captured async runtime reads", () => {
  it.each(["source", "reset", "captured source"])(
    "keeps the selected runtime/source pair after %s changes before continuation",
    async (change) => {
      const runtime: OpenClawConfig = { gateway: { port: 19001 } };
      const firstSource: OpenClawConfig = { gateway: { port: 19002 } };
      setRuntimeConfigSnapshot(runtime, firstSource);
      const selected = change === "captured source" ? captureRuntimeConfig(runtime) : runtime;
      setRuntimeConfigSnapshot(selected, firstSource);
      vi.stubEnv("CONFIG_CAPTURE_TEST", "original");
      const pending = loadPinnedRuntimeConfigAsync(async () => ({ config: {} }), { capture: true });
      if (change === "reset") {
        resetConfigRuntimeState();
      } else {
        setRuntimeConfigSnapshot(selected, { gateway: { port: 19003 } });
      }
      vi.stubEnv("CONFIG_CAPTURE_TEST", "replacement");
      const captured = await pending;
      expect(captured.config).toEqual(runtime);
      expect(projectConfigOntoRuntimeSourceSnapshot(captured.config)).toEqual(firstSource);
      expect(captured.env.CONFIG_CAPTURE_TEST).toBe("original");
      if (change === "captured source") {
        const next = await loadPinnedRuntimeConfigAsync(async () => ({ config: {} }), {
          capture: true,
        });
        expect(projectConfigOntoRuntimeSourceSnapshot(next.config)).toEqual({
          gateway: { port: 19003 },
        });
      }
    },
  );

  it("captures a cold publication before queued source replacement", async () => {
    const runtime: OpenClawConfig = { gateway: { port: 19001 } };
    const release = sessionChanges.subscribe(() => {
      release();
      queueMicrotask(() => setRuntimeConfigSnapshot(runtime, { gateway: { port: 19002 } }));
    });
    try {
      const captured = await loadPinnedRuntimeConfigAsync(async () => ({ config: runtime }), {
        capture: true,
      });
      expect(getRuntimeConfigSourceSnapshot()).toEqual({ gateway: { port: 19002 } });
      expect(projectConfigOntoRuntimeSourceSnapshot(captured.config)).toEqual(runtime);
    } finally {
      release();
    }
  });
});
