import { describe, expect, it } from "vitest";
import {
  normalizeSessionsSendArguments,
  readSessionsSendMessage,
} from "./sessions-send-tool.input.js";

describe("sessions_send input compatibility", () => {
  it.each(["SendMessage", "content", "text"])(
    "normalizes %s without mutating the caller",
    (alias) => {
      const input = {
        [alias]: "accepted continuation",
        sessionKey: "agent:main:child",
        mode: "resume",
      };
      const normalized = normalizeSessionsSendArguments(input);
      expect(readSessionsSendMessage(normalized)).toBe("accepted continuation");
      expect(normalized).toEqual({
        message: "accepted continuation",
        sessionKey: "agent:main:child",
        mode: "resume",
      });
      expect(input[alias]).toBe("accepted continuation");
    },
  );

  it("preserves a canonical message over aliases and rejects empty input", () => {
    expect(normalizeSessionsSendArguments({ message: "original", text: "replacement" })).toEqual({
      message: "original",
    });
    expect(() =>
      readSessionsSendMessage(normalizeSessionsSendArguments({ content: "  " })),
    ).toThrow();
  });
});
