export type JsonSchema = {
  "~openclawClosedObjectIdentity"?: symbol;
  type?: string | string[];
  const?: boolean | number | string | null;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<boolean | number | string | null>;
  patternProperties?: Record<string, JsonSchema>;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
};

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, stableJson(record[key])]),
    );
  }
  return value;
}

export function schemaSignature(schema: JsonSchema): string {
  return JSON.stringify(stableJson(schema));
}

/** Swift represents ChatSend fields; its conditional CAS pairing remains a runtime schema constraint. */
export function swiftObjectSchema(name: string, schema: JsonSchema): JsonSchema {
  if (name !== "ChatSendParams" || schema.type === "object") {
    return schema;
  }
  const fields = schema.allOf?.[0];
  if (
    fields?.type !== "object" ||
    fields.additionalProperties !== false ||
    !fields.properties?.expectedSessionId ||
    !fields.properties.expectedLifecycleRevision ||
    fields.required?.includes("expectedSessionId") ||
    fields.required?.includes("expectedLifecycleRevision")
  ) {
    throw new Error("Unexpected ChatSendParams field schema for Swift generation");
  }
  return fields;
}
