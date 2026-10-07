import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const warnings = vi.hoisted(() => [] as string[]);

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logWarn: (message: unknown, ...rest: unknown[]) => {
      warnings.push(String(message));
      return actual.logWarn(message as never, ...(rest as never[]));
    },
  };
});

import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { runWithAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const MEMORY_PATH = "memory/2026-08-22.md";

function harnessTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `trusted harness ${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
}

describe("memory flush writer availability", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    warnings.length = 0;
  });

  it.each([false, true])(
    "keeps only read and append-only write after full file-flush assembly (search controls: %s)",
    (includeToolSearchControls) => {
      const tools = runWithAgentRingZeroTools(
        [harnessTool("openclaw"), harnessTool("tool_call")],
        () =>
          createOpenClawCodingTools({
            workspaceDir: tempDirs.make("openclaw-file-flush-"),
            trigger: "memory",
            memoryFlushWritePath: MEMORY_PATH,
            senderIsOwner: true,
            includeToolSearchControls,
          }),
      );
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(["read", "write"]);
    },
  );

  it("preserves foreground harness execution tools and their discovery precedence", () => {
    const tools = runWithAgentRingZeroTools(
      [harnessTool("openclaw"), harnessTool("tool_call")],
      () =>
        createOpenClawCodingTools({
          workspaceDir: tempDirs.make("openclaw-foreground-tools-"),
          senderIsOwner: true,
          includeToolSearchControls: true,
        }),
    );
    expect(tools.find((tool) => tool.name === "openclaw")?.description).toBe(
      "trusted harness openclaw",
    );
    expect(tools.find((tool) => tool.name === "tool_call")?.description).toBe(
      "trusted harness tool_call",
    );
    expect(tools.some((tool) => tool.name === "tool_search" || tool.name === "tool_describe")).toBe(
      false,
    );
  });

  it.each([
    {
      name: "denied by policy",
      config: { tools: { deny: ["write"] } },
      messageProvider: undefined,
      writable: false,
      warning: true,
    },
    {
      name: "excluded by transport",
      config: undefined,
      messageProvider: "node",
      writable: false,
      warning: false,
    },
    {
      name: "available",
      config: undefined,
      messageProvider: undefined,
      writable: true,
      warning: false,
    },
  ])("reports a writer $name", ({ config, messageProvider, writable, warning }) => {
    const tools = createOpenClawCodingTools({
      workspaceDir: tempDirs.make("openclaw-flush-writer-"),
      config,
      messageProvider,
      trigger: "memory",
      memoryFlushWritePath: MEMORY_PATH,
      senderIsOwner: true,
    });
    expect(tools.some((tool) => tool.name === "write")).toBe(writable);
    const flushWarnings = warnings.filter((line) => line.includes("memory flush cannot persist"));
    expect(flushWarnings).toEqual(warning ? [expect.stringContaining(MEMORY_PATH)] : []);
  });
});
