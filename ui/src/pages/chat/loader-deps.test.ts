import { describe, expect, it } from "vitest";
import type { RouteLocation } from "../../router/index.ts";
import { chatSessionLoaderDeps } from "./loader-deps.ts";

function location(search: string): RouteLocation {
  return { pathname: "/chat", search, hash: "" };
}

describe("chatSessionLoaderDeps", () => {
  it("keys loader data by the requested session", () => {
    expect(chatSessionLoaderDeps(location("?session=agent%3Amain%3Amain"))).toBe("agent:main:main");
    expect(chatSessionLoaderDeps(location("?session=agent%3Asupport%3Amain"))).toBe(
      "agent:support:main",
    );
  });
});
