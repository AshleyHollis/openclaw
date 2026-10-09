// Diagnostic preload only: listen to npm's existing time events without adding
// handles, changing commands, or depending on npm's normal finish path.
const publicPhases = new Set([
  "npm",
  "npm:load",
  "npm:load:configload",
  "npm:load:mkdirpcache",
  "npm:load:mkdirplogs",
  "npm:load:setTitle",
  "npm:load:display",
  "npm:load:logFile",
  "npm:load:timers",
  "command:pack",
  "arborist:ctor",
  "arborist:loadActual",
]);
const pending = new Set();
process.on("time", (event, name) => {
  if (!publicPhases.has(name)) {
    return;
  }
  if (event === "start") {
    pending.add(name);
  } else if (event === "end") {
    pending.delete(name);
  }
});
process.once("exit", () => {
  if ((process.title === "npm" || process.title.startsWith("npm ")) && pending.size > 0) {
    console.error(JSON.stringify({ npmPendingPublicPhases: [...pending].sort() }));
  }
});
