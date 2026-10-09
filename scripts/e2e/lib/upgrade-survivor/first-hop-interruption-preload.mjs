// Fixture-only OS fault at the original driver's real package-displacement rename.
// No product files, ledger records or callback outcomes are authored here.
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const configPath = process.env.OPENCLAW_FIRST_HOP_INTERRUPTION_CONFIG;
if (configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(fs.realpathSync(config.fixtureRoot), config.fixtureRoot);
  const rename = promises.rename.bind(promises);
  promises.rename = async (from, to) => {
    // Other operations and processes keep their original native behavior.
    if (path.resolve(String(from)) !== config.liveRoot) return rename(from, to);
    const destination = path.resolve(String(to));
    assert(destination.startsWith(config.fixtureRoot + path.sep), "retirement escaped fixture");
    assert.equal(fs.realpathSync(from), config.liveRoot, "source alias escaped fixture");
    assert.equal(fs.realpathSync(path.dirname(destination)), path.dirname(destination), "destination parent alias");
    const parent = fs.realpathSync(path.dirname(destination));
    assert(parent === config.fixtureRoot || parent.startsWith(config.fixtureRoot + path.sep), "canonical retirement escaped fixture");
    assert(!fs.existsSync(destination), "retirement destination already exists");
    const manifest = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
    const build = JSON.parse(fs.readFileSync(path.join(from, "dist/build-info.json"), "utf8"));
    assert.equal(manifest.version, config.baselineVersion);
    assert.equal(build.commit, config.baselineSource);
    assert.equal(build.version, config.baselineVersion);
    await rename(from, to); // The shipped driver actually retires its own prefix.
    assert(!fs.existsSync(config.liveRoot), "live prefix was not displaced");
    assert(fs.statSync(destination).isDirectory(), "retired original is missing");
    fs.writeFileSync(config.marker + ".pending", JSON.stringify({
      schema: "openclaw.first-hop-interruption-marker.v1", runId: config.runId,
      pid: process.pid, at: new Date().toISOString(), liveRoot: config.liveRoot,
      retiredRoot: destination, baselineVersion: manifest.version,
      baselineSource: build.commit, targetSha256: config.targetSha256,
      boundary: "after-original-prefix-rename-before-candidate-publication",
    }) + "\n", { flag: "wx", mode: 0o600 });
    fs.linkSync(config.marker + ".pending", config.marker);
    fs.unlinkSync(config.marker + ".pending");
    // The owning external observer records and terminates the whole process group.
    // Returning fake failure/success or constructing a ledger would not prove this.
    process.kill(process.pid, "SIGSTOP");
    throw new Error("Interrupted driver must never resume package publication");
  };
  syncBuiltinESMExports();
}
