import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "../../cron/service.test-harness.js";
import type { CronJobCreate } from "../../cron/types.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createCronTestContext } from "./cron.validation.test-support.js";

vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryPreview: vi.fn(async () => ({ label: "none", detail: "none" })),
}));

import { cronHandlers } from "./cron.js";

const id = "command-center:follow-up:123";
const params: CronJobCreate = {
  id,
  name: "Follow up",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Follow up" },
  delivery: { mode: "none" },
};
const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-conditional-id-" });
installCronTestHooks({ logger });
const services = new Set<CronService>();
afterEach(() => {
  for (const service of services) {
    service.stop();
  }
  services.clear();
});

async function setup() {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  services.add(cron);
  const context = createCronTestContext(undefined, () => ({}) as OpenClawConfig);
  // Keep the registered handler and real durable add owner; only delivery preview is mocked.
  context.cron.add.mockImplementation((input, options) =>
    cron.add(input as CronJobCreate, options),
  );
  return { context, cron };
}

async function invokeAdd(
  context: ReturnType<typeof createCronTestContext>,
  input: CronJobCreate = params,
) {
  const respond = vi.fn();
  await expectDefined(
    cronHandlers["cron.add"],
    "cron.add handler",
  )({
    req: {} as never,
    // Match the decoded JSON RPC boundary: undefined optional fields are absent.
    params: JSON.parse(JSON.stringify(input)) as never,
    respond: respond as never,
    context: context as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function expectInvalidRequest(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
}

describe("conditional cron.add id", () => {
  it("creates the exact public ID and preserves an operator edit after an uncertain-response retry", async () => {
    const { context, cron } = await setup();
    expect(await invokeAdd(context)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id }),
      undefined,
    );
    await cron.update(id, {
      enabled: false,
      payload: { kind: "agentTurn", message: "operator edit" },
    });
    const before = await cron.readJob(id);
    expectInvalidRequest(await invokeAdd(context));
    expect(await cron.readJob(id)).toEqual(before);
    expect(await cron.list({ includeDisabled: true })).toHaveLength(1);
  });

  it("returns one winner for concurrent public exact-ID adds", async () => {
    const { context, cron } = await setup();
    const responses = await Promise.all([invokeAdd(context), invokeAdd(context)]);
    expect(responses.filter((response) => response.mock.calls[0]?.[0] === true)).toHaveLength(1);
    expect(responses.filter((response) => response.mock.calls[0]?.[0] === false)).toHaveLength(1);
    expect(await cron.list({ includeDisabled: true })).toEqual([expect.objectContaining({ id })]);
  });

  it("rejects ID plus declarationKey for both matching and differing identities", async () => {
    const { context, cron } = await setup();
    const declarationKey = "follow-up-declaration";
    await invokeAdd(context, { ...params, id: undefined, declarationKey });
    const [created] = await cron.list({ includeDisabled: true });
    const existingId = expectDefined(created, "created declaration").id;
    await cron.update(existingId, { payload: { kind: "agentTurn", message: "operator edit" } });
    const before = await cron.readJob(existingId);
    for (const requestedId of [existingId, id]) {
      expectInvalidRequest(
        await invokeAdd(context, { ...params, id: requestedId, declarationKey }),
      );
      expect(await cron.readJob(existingId)).toEqual(before);
      expect(await cron.list({ includeDisabled: true })).toHaveLength(1);
    }
  });

  it("classifies unsafe requested IDs without persisting a job", async () => {
    const { context, cron } = await setup();
    for (const requestedId of ["", "  ", "nested/job", "..\\job", "nul\0job"]) {
      expectInvalidRequest(await invokeAdd(context, { ...params, id: requestedId }));
    }
    expect(await cron.list({ includeDisabled: true })).toEqual([]);
  });

  it("keeps authority fencing at the durable add boundary", async () => {
    const { context, cron } = await setup();
    const respond = vi.fn();
    const sessionMutationCommitGuard = vi.fn(() => {
      throw new TypeError("creator authority is no longer active");
    });
    await expectDefined(
      cronHandlers["cron.add"],
      "cron.add handler",
    )({
      req: {} as never,
      params: params as never,
      respond: respond as never,
      context: context as never,
      client: null,
      isWebchatConnect: () => false,
      sessionMutationCommitGuard,
    });
    expect(sessionMutationCommitGuard).toHaveBeenCalled();
    expectInvalidRequest(respond);
    expect(await cron.list({ includeDisabled: true })).toEqual([]);
  });
});
