import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { loadSessionsForPage } from "./sessions.ts";

describe("sessions page loading", () => {
  it("passes the persisted page filters explicitly", async () => {
    const request = vi.fn().mockResolvedValue({ sessions: [] });
    const state = {
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      sessionsLoading: false,
      sessionsError: null,
      sessionsResult: null,
      sessionsFilterActive: "45",
      sessionsFilterLimit: "125",
      sessionsIncludeGlobal: false,
      sessionsIncludeUnknown: true,
      sessionsShowArchived: true,
      sessionsExpandedCheckpointKey: null,
      sessionsCheckpointItemsByKey: {},
      sessionsCheckpointLoadingKey: null,
      sessionsCheckpointBusyKey: null,
      sessionsCheckpointErrorByKey: {},
    } as Parameters<typeof loadSessionsForPage>[0];

    await loadSessionsForPage(state);

    expect(request).toHaveBeenCalledWith("sessions.list", {
      includeGlobal: false,
      includeUnknown: true,
      configuredAgentsOnly: true,
      archived: true,
      limit: 125,
    });
  });
});
