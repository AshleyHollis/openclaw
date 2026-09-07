import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadOfflineSessionPublicationIntent,
  publishOfflineSessionBundle,
  verifyOfflineSessionBundle,
  type OfflineSessionPublicationIntent,
} from "../../scripts/lib/offline-session-publication.mts";

const roots: string[] = [];
const originalNativeConfig = getFsSafeNativeConfig();
beforeAll(() => configureFsSafeNative({ mode: "require" }));
afterAll(() => configureFsSafeNative(originalNativeConfig));
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-publication-"));
  roots.push(root);
  const staged = path.join(root, "staged");
  const output = path.join(root, "output");
  await fs.mkdir(staged, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  const intent: OfflineSessionPublicationIntent = {
    schemaVersion: 1,
    agentId: "main",
    inputDigest: "a".repeat(64),
    preparationDigest: "b".repeat(64),
    members: [],
  };
  for (const [name, kind, text] of [
    ["sessions.sqlite", "database", "synthetic already-validated database bytes"],
    ["history.jsonl.deleted.test", "archive", "synthetic already-validated archive bytes"],
  ] as const) {
    const bytes = Buffer.from(text);
    const sourcePath = path.join(staged, name);
    await fs.writeFile(sourcePath, bytes, { flag: "wx", mode: 0o600 });
    const identity = await fs.stat(sourcePath, { bigint: true });
    intent.members.push({
      kind,
      sourcePath,
      targetPath: path.join(output, name),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      dev: String(identity.dev),
      ino: String(identity.ino),
    });
  }
  return { root, staged, output, publicationDir: path.join(root, "publication"), intent };
}

describe("offline Session bundle publication", () => {
  it.skipIf(process.platform === "win32").each(["staged", "published"])(
    "rejects %s members whose private permissions were broadened",
    async (stage) => {
      const f = await fixture();
      if (stage === "published") {
        await publishOfflineSessionBundle(f);
      }
      const member = f.intent.members[0]!;
      await fs.chmod(stage === "staged" ? member.sourcePath : member.targetPath, 0o644);
      await expect(publishOfflineSessionBundle(f)).rejects.toThrow(/private|ownership/);
      await expect(verifyOfflineSessionBundle(f)).rejects.toThrow();
    },
  );

  it("does not adopt a foreign same-content target after intent publication is interrupted", async () => {
    const f = await fixture();
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated(_method, target) {
        if (target.endsWith("/intent.json")) {
          throw new Error("synthetic interruption after intent");
        }
      },
    });
    await expect(publishOfflineSessionBundle(f)).rejects.toThrow(
      "synthetic interruption after intent",
    );
    __setFsSafeTestHooksForTest();
    const member = f.intent.members[0]!;
    await fs.copyFile(member.sourcePath, member.targetPath);
    const foreign = await fs.stat(member.targetPath);
    await expect(publishOfflineSessionBundle(f)).rejects.toThrow();
    await expect(verifyOfflineSessionBundle(f)).rejects.toThrow();
    expect((await fs.stat(member.targetPath)).ino).toBe(foreign.ino);
    await expect(fs.stat(path.join(f.publicationDir, "ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects rewritten member hashes against an independently pinned inventory", async () => {
    const f = await fixture();
    await publishOfflineSessionBundle(f);
    const recordPath = path.join(f.publicationDir, "intent.json");
    const original = await fs.readFile(recordPath);
    const approvedDigest = createHash("sha256").update(original).digest("hex");
    const expected = {
      agentId: f.intent.agentId,
      inputDigest: f.intent.inputDigest,
      preparationDigest: f.intent.preparationDigest,
      members: f.intent.members.map(({ kind, sourcePath, targetPath }) => ({
        kind,
        sourcePath,
        targetPath,
      })),
    };
    await expect(
      loadOfflineSessionPublicationIntent(f.publicationDir, expected, approvedDigest),
    ).resolves.toEqual(f.intent);
    const forged = JSON.parse(original.toString("utf8"));
    const replacement = Buffer.from("changed after verified preparation");
    const member = forged.members[0];
    member.sha256 = createHash("sha256").update(replacement).digest("hex");
    member.sizeBytes = replacement.length;
    await fs.writeFile(member.sourcePath, replacement);
    await fs.writeFile(member.targetPath, replacement);
    await fs.writeFile(recordPath, `${JSON.stringify(forged)}\n`);
    // A self-consistent intent is not the independently approved inventory.
    await expect(
      loadOfflineSessionPublicationIntent(f.publicationDir, expected, approvedDigest),
    ).rejects.toThrow(/inventory|digest|approval/i);
  });

  it.each([false, true])(
    "rejects a same-content source replacement (intent already recorded: %s)",
    async (recorded) => {
      const f = await fixture();
      if (recorded) {
        __setFsSafeTestHooksForTest({
          afterPublishTargetCreated(_method, target) {
            if (target.endsWith("/intent.json")) {
              throw new Error("synthetic interruption after intent");
            }
          },
        });
        await expect(publishOfflineSessionBundle(f)).rejects.toThrow(
          "synthetic interruption after intent",
        );
        __setFsSafeTestHooksForTest();
      }
      const member = f.intent.members[0]!;
      await fs.rename(member.sourcePath, `${member.sourcePath}.old`);
      await fs.copyFile(`${member.sourcePath}.old`, member.sourcePath);
      await expect(publishOfflineSessionBundle(f)).rejects.toThrow(/approved identity/);
      expect(await fs.readdir(f.output)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "refuses cross-filesystem publication without copying any member",
    async () => {
      const f = await fixture();
      const other = await fs.mkdtemp("/dev/shm/offline-publication-");
      roots.push(other);
      expect(String((await fs.stat(other, { bigint: true })).dev)).not.toBe(
        f.intent.members[1]!.dev,
      );
      f.intent.members[1]!.targetPath = path.join(other, "history.jsonl.deleted.test");
      await expect(publishOfflineSessionBundle(f)).rejects.toThrow(/same-filesystem/);
      expect(await fs.readdir(f.output)).toEqual([]);
      expect(await fs.readdir(other)).toEqual([]);
    },
  );

  it("refuses an aliased published directory during both verification and retry", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.output, "nested"));
    for (const member of f.intent.members) {
      member.targetPath = path.join(f.output, "nested", path.basename(member.targetPath));
    }
    await publishOfflineSessionBundle(f);
    const moved = path.join(f.root, "moved-output");
    await fs.rename(f.output, moved);
    await fs.symlink(moved, f.output, "dir");
    await expect(verifyOfflineSessionBundle(f)).rejects.toThrow(/alias|canonical/i);
    await expect(publishOfflineSessionBundle(f)).rejects.toThrow(/alias|canonical/i);
    expect((await fs.lstat(f.output)).isSymbolicLink()).toBe(true);
  });

  it("recovers a lost ready-directory-sync response without replacing outputs", async () => {
    const f = await fixture();
    __setFsSafeTestHooksForTest({
      beforePublishDirectorySync(_method, target) {
        if (target.endsWith("/ready.json")) {
          throw new Error("synthetic lost sync response");
        }
      },
    });
    await expect(publishOfflineSessionBundle(f)).rejects.toThrow("synthetic lost sync response");
    const identity = await fs.stat(f.intent.members[0]!.targetPath);
    __setFsSafeTestHooksForTest();
    await publishOfflineSessionBundle(f);
    await verifyOfflineSessionBundle(f);
    const after = await fs.stat(f.intent.members[0]!.targetPath);
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });

  it("never falls back to non-atomic publication when native support is disabled", async () => {
    const f = await fixture();
    configureFsSafeNative({ mode: "off" });
    try {
      await expect(publishOfflineSessionBundle(f)).rejects.toThrow(
        "native fs-safe helper is unavailable",
      );
      expect(getFsSafeNativeConfig().mode).toBe("off");
      expect(await fs.readdir(f.output)).toEqual([]);
      await expect(verifyOfflineSessionBundle(f)).rejects.toThrow();
    } finally {
      configureFsSafeNative({ mode: "require" });
    }
    await publishOfflineSessionBundle(f);
    await verifyOfflineSessionBundle(f);
  });

  it("recovers an interrupted empty intent directory without adopting foreign records", async () => {
    const f = await fixture();
    await fs.mkdir(f.publicationDir, { mode: 0o700 });
    await publishOfflineSessionBundle(f);
    await verifyOfflineSessionBundle(f);
    const foreign = await fixture();
    await fs.mkdir(foreign.publicationDir, { mode: 0o700 });
    await fs.writeFile(path.join(foreign.publicationDir, "foreign.json"), "retain");
    await expect(publishOfflineSessionBundle(foreign)).rejects.toThrow();
    expect(await fs.readdir(foreign.output)).toEqual([]);
  });

  it.each(["intent.json", "sessions.sqlite", "ready.json"])(
    "resumes in a fresh process after SIGKILL immediately following creation of %s",
    async (stopAt) => {
      const f = await fixture();
      const script = `
        import { __setFsSafeTestHooksForTest } from '@openclaw/fs-safe/test-hooks';
        import { publishOfflineSessionBundle } from './scripts/lib/offline-session-publication.mts';
        const options = JSON.parse(process.argv[1]);
        const stopAt = process.argv[2];
        __setFsSafeTestHooksForTest({ afterPublishTargetCreated(_method, target) {
          if (stopAt && target.endsWith('/' + stopAt)) process.kill(process.pid, 'SIGKILL');
        }});
        await publishOfflineSessionBundle(options);
      `;
      const run = (stop: string) =>
        promisify(execFile)(
          process.execPath,
          [
            "--import",
            "./scripts/tsx.mjs",
            "--input-type=module",
            "-e",
            script,
            JSON.stringify(f),
            stop,
          ],
          {
            cwd: process.cwd(),
            env: {
              PATH: process.env.PATH,
              LANG: "C.UTF-8",
              HOME: f.root,
              TMPDIR: f.root,
              NODE_ENV: "test",
              OPENCLAW_FS_SAFE_NATIVE_MODE: "require",
            },
            timeout: 60_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
        );
      await expect(run(stopAt)).rejects.toMatchObject({ signal: "SIGKILL" });
      await run("");
      await verifyOfflineSessionBundle(f);
      for (const member of f.intent.members) {
        expect((await fs.stat(member.targetPath)).nlink).toBe(1);
      }
    },
  );

  it("publishes the complete approved inventory and verifies after private staging is gone", async () => {
    const f = await fixture();
    await publishOfflineSessionBundle(f);
    await fs.rm(f.staged, { recursive: true });
    await verifyOfflineSessionBundle(f);
    // Lost success responses must not trigger preparation or overwrite outputs.
    await publishOfflineSessionBundle(f);
    expect((await fs.readdir(f.output)).toSorted()).toEqual([
      "history.jsonl.deleted.test",
      "sessions.sqlite",
    ]);
  });

  it("refuses incomplete output, then resumes the same intent without replacing published files", async () => {
    const f = await fixture();
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated(_method, target) {
        if (target === f.intent.members[0]!.targetPath) {
          throw new Error("synthetic interruption after first member");
        }
      },
    });
    await expect(publishOfflineSessionBundle(f)).rejects.toThrow(
      "synthetic interruption after first member",
    );
    const first = await fs.stat(f.intent.members[0]!.targetPath);
    await expect(verifyOfflineSessionBundle(f)).rejects.toThrow();
    await expect(fs.stat(path.join(f.publicationDir, "ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    __setFsSafeTestHooksForTest();
    await publishOfflineSessionBundle(f);
    const resumed = await fs.stat(f.intent.members[0]!.targetPath);
    expect([resumed.dev, resumed.ino]).toEqual([first.dev, first.ino]);
    await verifyOfflineSessionBundle(f);
  });

  it.each(["inputDigest", "preparationDigest", "agentId"] as const)(
    "refuses an existing bundle for a different approved %s",
    async (field) => {
      const f = await fixture();
      await publishOfflineSessionBundle(f);
      f.intent[field] = field === "agentId" ? "other" : "c".repeat(64);
      await expect(verifyOfflineSessionBundle(f)).rejects.toThrow();
      await expect(publishOfflineSessionBundle(f)).rejects.toThrow();
    },
  );

  it("refuses stale prepared bytes before publishing any output", async () => {
    const f = await fixture();
    await fs.appendFile(f.intent.members[1]!.sourcePath, "changed");
    await expect(publishOfflineSessionBundle(f)).rejects.toThrow();
    expect(await fs.readdir(f.output)).toEqual([]);
  });

  it("does not adopt a preexisting target even when its bytes match", async () => {
    const f = await fixture();
    await fs.copyFile(f.intent.members[0]!.sourcePath, f.intent.members[0]!.targetPath);
    await expect(publishOfflineSessionBundle(f)).rejects.toThrow();
    await expect(verifyOfflineSessionBundle(f)).rejects.toThrow();
  });

  it.each(["changed", "same-bytes-replacement", "symlink"])(
    "refuses a completed bundle with %s output",
    async (change) => {
      const f = await fixture();
      await publishOfflineSessionBundle(f);
      const member = f.intent.members[0]!;
      if (change === "changed") {
        await fs.appendFile(member.targetPath, "changed");
      } else {
        // Keep the original inode allocated so replacement cannot reuse it.
        await fs.rename(member.targetPath, `${member.targetPath}.old`);
        if (change === "symlink") {
          await fs.symlink(`${member.targetPath}.old`, member.targetPath);
        } else {
          await fs.copyFile(`${member.targetPath}.old`, member.targetPath);
        }
      }
      await expect(verifyOfflineSessionBundle(f)).rejects.toThrow();
      await expect(publishOfflineSessionBundle(f)).rejects.toThrow();
    },
  );
});
