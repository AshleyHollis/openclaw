import { describe, expect, it } from "vitest";
import { ChatSendParamsSchema } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { type JsonSchema, swiftObjectSchema } from "../../scripts/lib/protocol-codegen-schema.js";

describe("Swift ChatSend field projection", () => {
  it("retains the actual closed-object fields without changing runtime CAS validation", () => {
    const schema = ChatSendParamsSchema as JsonSchema;
    const before = JSON.stringify(schema);
    const fields = swiftObjectSchema("ChatSendParams", schema);
    expect(fields).toBe(schema.allOf?.[0]);
    expect(fields.properties).toHaveProperty("expectedSessionId");
    expect(fields.properties).toHaveProperty("expectedLifecycleRevision");
    expect(fields.required).not.toContain("expectedSessionId");
    expect(fields.required).not.toContain("expectedLifecycleRevision");
    expect(JSON.stringify(schema)).toBe(before);
    expect(fields.required).toEqual(schema.allOf?.[0].required);
  });

  it("leaves unrelated and ordinary object schemas untouched", () => {
    const schema = ChatSendParamsSchema as JsonSchema;
    expect(swiftObjectSchema("Unrelated", schema)).toBe(schema);
    const object = schema.allOf?.[0] as JsonSchema;
    expect(swiftObjectSchema("ChatSendParams", object)).toBe(object);
  });

  it("fails loudly on an unexpected ChatSend field structure", () => {
    expect(() => swiftObjectSchema("ChatSendParams", {})).toThrow("Unexpected ChatSendParams");
    expect(() => swiftObjectSchema("ChatSendParams", { allOf: [{ type: "object" }] })).toThrow(
      "Unexpected ChatSendParams",
    );
    const fields = (ChatSendParamsSchema as JsonSchema).allOf?.[0] as JsonSchema;
    expect(() =>
      swiftObjectSchema("ChatSendParams", {
        allOf: [{ ...fields, required: [...(fields.required ?? []), "expectedSessionId"] }],
      }),
    ).toThrow("Unexpected ChatSendParams");
  });
});
