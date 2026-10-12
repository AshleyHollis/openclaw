import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "./legacy.js";

describe("retired heartbeat config diagnostics", () => {
  it.each([true, false])(
    "names a retained skipWhenBusy value of %s without repairing it",
    (value) => {
      const raw = {
        agents: { entries: { main: {} }, defaults: { heartbeat: { skipWhenBusy: value } } },
      };
      const original = structuredClone(raw);

      expect(findLegacyConfigIssues(raw)).toEqual(
        expect.arrayContaining([
          {
            path: "agents.defaults.heartbeat.skipWhenBusy",
            message:
              'agents.defaults.heartbeat.skipWhenBusy is retired. Run "openclaw doctor --fix".',
          },
          {
            path: "",
            message:
              'Approved tier-eval configuration surfaces were consolidated. Run "openclaw doctor --fix".',
          },
        ]),
      );
      expect(raw).toEqual(original);
    },
  );

  it("does not report the absent retired key", () => {
    const raw = { agents: { entries: { main: {} }, defaults: { heartbeat: {} } } };
    const original = structuredClone(raw);

    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(raw).toEqual(original);
  });

  it("retains the generic diagnostic for another tier-eval key without naming skipWhenBusy", () => {
    const raw = {
      agents: { entries: { main: {} }, defaults: { heartbeat: { includeReasoning: true } } },
    };
    const original = structuredClone(raw);
    const issues = findLegacyConfigIssues(raw);

    expect(issues).toContainEqual({
      path: "",
      message:
        'Approved tier-eval configuration surfaces were consolidated. Run "openclaw doctor --fix".',
    });
    expect(issues.some((issue) => `${issue.path} ${issue.message}`.includes("skipWhenBusy"))).toBe(
      false,
    );
    expect(raw).toEqual(original);
  });
});
