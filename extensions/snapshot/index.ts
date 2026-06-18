// Snapshot plugin entrypoint keeps the provider packaged for opt-in use.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "snapshot",
  name: "Snapshot",
  description: "Creates and verifies SQLite-safe OpenClaw state snapshots.",
  register() {},
});
