import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCronTestContext } from "./cron.validation.test-support.js";

vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryPreview: vi.fn(async () => ({ label: "none", detail: "none" })),
}));

import { cronHandlers } from "./cron.js";

const id = "command-center:follow-up:123";
const params = {
  id,
  name: "Follow up",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Follow up" },
  delivery: { mode: "none" },
};

async function invokeAdd(context = createCronTestContext(undefined, () => ({}) as OpenClawConfig)) {
  const respond = vi.fn();
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
  });
  return { context, respond };
}

describe("conditional cron.add id", () => {
  it("forwards the exact caller id through the public Gateway handler", async () => {
    const { context, respond } = await invokeAdd();

    expect(context.committedAdds).toEqual([expect.objectContaining({ id })]);
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  });

  it("returns an invalid request for an existing id", async () => {
    const context = createCronTestContext(undefined, () => ({}) as OpenClawConfig);
    context.cron.add.mockRejectedValueOnce(new Error(`cron job already exists: ${id}`));

    const { respond } = await invokeAdd(context);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
