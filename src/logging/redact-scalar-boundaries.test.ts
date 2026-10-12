import { expect, it } from "vitest";
import { redactLogRecordForTransport } from "./redact.js";

it.each(["\n", "\r", "\t"])("preserves decoded separator %j after a bare password", (separator) => {
  const record = { message: `pass: abcdef12${separator}Keep this text.`, level: "info" };
  expect(redactLogRecordForTransport(record)).toEqual({
    message: `pass: ***${separator}Keep this text.`,
    level: "info",
  });
  expect(record.message).toContain("abcdef12");
});

it("protects structured credentials while retaining the following message line", () => {
  expect(
    redactLogRecordForTransport({
      message: "pass: abcdef12\nKeep this text.",
      password: "abcdef12",
      detail: { password: "abcdef12" },
    }),
  ).toEqual({
    message: "pass: ***\nKeep this text.",
    password: "***",
    detail: { password: "***" },
  });
});

it("retains bare password protection in JSON keys excluded from scalar decoding", () => {
  expect(redactLogRecordForTransport({ "pass: abcdef12": "ordinary" })).toEqual({
    "pass: ***": "ordinary",
  });
});

it("retains bare password protection in native toJSON strings", () => {
  class NativeValue {
    toJSON() {
      return "pass: abcdef12";
    }
  }
  expect(redactLogRecordForTransport({ value: new NativeValue() })).toEqual({ value: "pass: ***" });
});
