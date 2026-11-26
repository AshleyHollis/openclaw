import { Type } from "typebox";
import { PLUGIN_UI_CAPABILITIES } from "../plugin-ui-capabilities.js";

export const PluginUiCapabilitySchema = Type.Enum(PLUGIN_UI_CAPABILITIES, { type: "string" });
export const PluginUiCapabilitiesSchema = Type.Array(PluginUiCapabilitySchema, {
  maxItems: PLUGIN_UI_CAPABILITIES.length,
  uniqueItems: true,
});
