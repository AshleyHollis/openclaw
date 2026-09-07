import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  prepareOfflineSessionSnapshot,
  publishPreparedOfflineSessionSnapshot,
} from "../../scripts/lib/offline-session-preparation.mts";
import {
  createEvent,
  createLegacyDatabaseFixture,
  readDatabaseSnapshot,
} from "../infra/state-migrations.media-persistence.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createFixturePreparationApproval } from "./offline-session-preparation.test-support.js";

const roots: string[] = [];
const originalNativeConfig = getFsSafeNativeConfig();
beforeAll(() => configureFsSafeNative({ mode: "require" }));
afterAll(() => configureFsSafeNative(originalNativeConfig));
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabase();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true });
  }
});

async function fixture(withArchive = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offline-admission-"));
  roots.push(root);
  const sourceRoot = path.join(root, "original");
  const sourcePath = createLegacyDatabaseFixture({
    env: { OPENCLAW_STATE_DIR: sourceRoot },
    eventsBySession: {
      "session-a": [
        createEvent({
          id: "one",
          parentId: null,
          timestamp: 1000,
          message: {
            role: "user",
            content: "Preserve this history",
            MediaPath: "/fictional/receipt.pdf",
          },
        }),
      ],
    },
  });
  await closeOpenClawAgentDatabasesAsync(sourceRoot);
  closeOpenClawStateDatabase();
  const archivePath = path.join(
    sourceRoot,
    "agents",
    "main",
    "sessions",
    "cold.jsonl.reset.2026-07-24T01-02-03.000Z",
  );
  const archiveBytes = `${JSON.stringify(createEvent({ id: "archived", parentId: null, timestamp: 500, message: { role: "user", content: "Preserve older history" } }))}\n`;
  if (withArchive) {
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, archiveBytes);
  }
  const options = {
    sourcePath,
    targetPath: path.join(root, "sessions.sqlite"),
    privateStateDir: path.join(root, "scratch"),
    agentId: "main",
  };
  const approved = await createFixturePreparationApproval(options);
  return { root, sourceRoot, archivePath, archiveBytes, options: { ...options, ...approved } };
}

describe("approved offline Session preparation", () => {
  it("does not claim publication ready when the new archive directory edge cannot sync", async () => {
    const f = await fixture(true);
    const targetPath = path.join(f.root, "prepared", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const input = {
      sourcePath: f.options.sourcePath,
      agentId: "main",
      targetPath,
      privateStateDir: path.join(f.root, "durable-scratch"),
    };
    const options = { ...input, ...(await createFixturePreparationApproval(input)) };
    const staged = await prepareOfflineSessionSnapshot(options);
    const open = fs.open.bind(fs);
    const fault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path.join(f.root, "prepared")) {
        handle.sync = async () => {
          throw new Error("synthetic archive parent sync failure");
        };
      }
      return handle;
    });
    try {
      await expect(
        publishPreparedOfflineSessionSnapshot({ ...options, ...staged }),
      ).rejects.toThrow(/sync/);
      await expect(
        fs.stat(path.join(options.publicationDir, "bundle", "ready.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      fault.mockRestore();
    }
    await expect(
      publishPreparedOfflineSessionSnapshot({ ...options, ...staged }),
    ).resolves.toMatchObject({ cleanup: "removed" });
  });

  it("does not report scratch removed until its missing directory edge is durably synced", async () => {
    const f = await fixture();
    const staged = await prepareOfflineSessionSnapshot(f.options);
    const open = fs.open.bind(fs);
    const fault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path.dirname(f.options.privateStateDir)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (!(await fs.lstat(f.options.privateStateDir).catch(() => undefined))) {
            throw new Error("synthetic cleanup parent sync failure");
          }
          await sync();
        };
      }
      return handle;
    });
    try {
      await expect(
        publishPreparedOfflineSessionSnapshot({ ...f.options, ...staged }),
      ).resolves.toMatchObject({ cleanup: "retained" });
    } finally {
      fault.mockRestore();
    }
    await expect(
      publishPreparedOfflineSessionSnapshot({ ...f.options, ...staged }),
    ).resolves.toMatchObject({ cleanup: "removed" });
  });

  it("prepares a pinned inventory without publishing or discarding its staged files", async () => {
    const f = await fixture(true);
    const original = await fs.readFile(f.options.sourcePath);
    const prepared = await prepareOfflineSessionSnapshot(f.options);
    await expect(fs.stat(f.options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(f.root, path.basename(f.archivePath)))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(f.options.publicationDir, "bundle", "ready.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(f.options.privateStateDir)).isDirectory()).toBe(true);
    expect(prepared).toEqual({
      schemaVersion: 19,
      preparationRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      publicationIntentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await fs.readFile(f.options.sourcePath)).toEqual(original);
    expect(await fs.readFile(f.archivePath, "utf8")).toBe(f.archiveBytes);
  });

  it("does not adopt a matching destination created before publication approval", async () => {
    const f = await fixture();
    const prepared = await prepareOfflineSessionSnapshot(f.options);
    await fs.copyFile(
      path.join(f.options.privateStateDir, "prepared-session.sqlite"),
      f.options.targetPath,
    );
    await expect(
      publishPreparedOfflineSessionSnapshot({ ...f.options, ...prepared }),
    ).rejects.toThrow("pre-existing output");
    await expect(
      fs.stat(path.join(f.options.publicationDir, "bundle", "ready.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a rewritten preparation record even when its proposal agrees", async () => {
    const f = await fixture();
    const staged = await prepareOfflineSessionSnapshot(f.options);
    const recordPath = path.join(f.options.publicationDir, "preparation.json");
    const proposalPath = path.join(f.options.publicationDir, "proposal", "intent.json");
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    record.scratchIdentity.ino = "0";
    const replacement = Buffer.from(`${JSON.stringify(record)}\n`);
    await fs.writeFile(recordPath, replacement);
    const proposal = JSON.parse(await fs.readFile(proposalPath, "utf8"));
    proposal.inputDigest = createHash("sha256").update(replacement).digest("hex");
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal)}\n`);
    await expect(
      publishPreparedOfflineSessionSnapshot({ ...f.options, ...staged }),
    ).rejects.toThrow("preparation digest differs");
    await expect(fs.stat(f.options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(f.options.publicationDir, "bundle"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fs.stat(f.options.privateStateDir)).isDirectory()).toBe(true);
  });

  it.each(["database-parent", "archive-parent", "missing-child"])(
    "refuses an aliased %s before creating private or final artifacts",
    async (kind) => {
      const f = await fixture(true);
      const foreign = path.join(f.root, "foreign");
      await fs.mkdir(foreign);
      await fs.writeFile(path.join(foreign, "sentinel"), "untouched");
      if (kind === "database-parent") {
        await fs.mkdir(path.join(foreign, "nested"));
      }
      const foreignEntries = await fs.readdir(foreign);
      const alias = path.join(f.root, kind === "archive-parent" ? "sessions" : "alias");
      await fs.symlink(foreign, alias, "dir");
      if (kind === "archive-parent") {
        await fs.mkdir(path.join(f.root, "agent"));
      }
      const options = {
        sourcePath: f.options.sourcePath,
        agentId: "main",
        targetPath:
          kind === "archive-parent"
            ? path.join(f.root, "agent", "openclaw-agent.sqlite")
            : path.join(
                alias,
                kind === "missing-child" ? "missing/sessions.sqlite" : "nested/sessions.sqlite",
              ),
        privateStateDir: path.join(f.root, "aliased-scratch"),
      };
      const approved = await createFixturePreparationApproval(options);
      const original = await fs.readFile(options.sourcePath);
      await expect(prepareOfflineSessionSnapshot({ ...options, ...approved })).rejects.toThrow(
        /alias|canonical/i,
      );
      await expect(fs.stat(options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(approved.publicationDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(foreign)).toEqual(foreignEntries);
      if (kind === "database-parent") {
        expect(await fs.readdir(path.join(foreign, "nested"))).toEqual([]);
      }
      expect(await fs.readFile(path.join(foreign, "sentinel"), "utf8")).toBe("untouched");
      expect(await fs.readFile(options.sourcePath)).toEqual(original);
      expect(await fs.readFile(f.archivePath, "utf8")).toBe(f.archiveBytes);
    },
  );

  it("refuses derived final archives inside scratch before creating any output", async () => {
    const f = await fixture(true);
    const options = {
      sourcePath: f.options.sourcePath,
      agentId: "main",
      targetPath: path.join(f.root, "agent", "openclaw-agent.sqlite"),
      privateStateDir: path.join(f.root, "sessions"),
    };
    await fs.mkdir(path.dirname(options.targetPath));
    const approved = await createFixturePreparationApproval(options);
    await expect(prepareOfflineSessionSnapshot({ ...options, ...approved })).rejects.toThrow(
      "independent",
    );
    await expect(fs.stat(options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(approved.publicationDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(f.archivePath, "utf8")).toBe(f.archiveBytes);
  });

  it.each(["archive", "companion"])(
    "refuses a final database colliding with an original %s",
    async (kind) => {
      const f = await fixture(true);
      const targetPath = kind === "archive" ? f.archivePath : `${f.options.sourcePath}-wal`;
      const options = {
        sourcePath: f.options.sourcePath,
        agentId: "main",
        targetPath,
        privateStateDir: path.join(f.root, "collision-scratch"),
      };
      const approved = await createFixturePreparationApproval(options);
      await expect(prepareOfflineSessionSnapshot({ ...options, ...approved })).rejects.toThrow(
        "independent",
      );
      await expect(fs.stat(options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(f.archivePath, "utf8")).toBe(f.archiveBytes);
    },
  );

  it.each(["privateStateDir", "publicationDir"] as const)(
    "refuses an approval record inside %s",
    async (key) => {
      const f = await fixture();
      const bytes = await fs.readFile(f.options.approvalManifestPath);
      await fs.mkdir(f.options[key]);
      const approvalManifestPath = path.join(f.options[key], "approval.json");
      await fs.writeFile(approvalManifestPath, bytes);
      await expect(
        prepareOfflineSessionSnapshot({
          ...f.options,
          approvalManifestPath,
          approvalManifestSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      ).rejects.toThrow("independent");
      expect(await fs.readdir(f.options[key])).toEqual(["approval.json"]);
      await expect(fs.stat(f.options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves final archives in the native sibling layout after scratch cleanup", async () => {
    const f = await fixture(true);
    const options = {
      sourcePath: f.options.sourcePath,
      agentId: "main",
      targetPath: path.join(f.root, "prepared", "agent", "openclaw-agent.sqlite"),
      privateStateDir: path.join(f.root, "native-scratch"),
    };
    await fs.mkdir(path.dirname(options.targetPath), { recursive: true });
    const approved = await createFixturePreparationApproval(options);
    const staged = await prepareOfflineSessionSnapshot({ ...options, ...approved });
    const result = await publishPreparedOfflineSessionSnapshot({
      ...options,
      ...approved,
      ...staged,
    });
    expect(result.cleanup).toBe("removed");
    expect(
      await fs.readFile(
        path.join(f.root, "prepared", "sessions", path.basename(f.archivePath)),
        "utf8",
      ),
    ).toBe(f.archiveBytes);
    expect(readDatabaseSnapshot(options.targetPath).rows).toHaveLength(1);
    await expect(fs.stat(options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["-wal", "-shm", "-journal"])(
    "refuses an unapproved %s before native state creation",
    async (suffix) => {
      const f = await fixture();
      await fs.writeFile(`${f.options.sourcePath}${suffix}`, "unapproved companion");
      await expect(prepareOfflineSessionSnapshot(f.options)).rejects.toThrow("companion inventory");
      await expect(fs.stat(f.options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses a newly discovered archive absent from the approved inventory", async () => {
    const f = await fixture();
    const archiveDir = path.join(f.sourceRoot, "agents", "main", "sessions");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, "cold.jsonl.reset.2026-07-24T01-02-03.000Z"), "{}\n");
    await expect(prepareOfflineSessionSnapshot(f.options)).rejects.toThrow("archive inventory");
    await expect(fs.stat(f.options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a companion introduced during private copying before selecting a native snapshot", async () => {
    const f = await fixture();
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated(_method, target) {
        if (target.endsWith("/original-input/database.sqlite")) {
          await fs.writeFile(`${f.options.sourcePath}-wal`, "late companion");
        }
      },
    });
    await expect(prepareOfflineSessionSnapshot(f.options)).rejects.toThrow("companion inventory");
    await expect(
      fs.stat(
        path.join(f.options.privateStateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(f.options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes recorded publication after a lost effect response without reopening source data", async () => {
    const f = await fixture();
    const staged = await prepareOfflineSessionSnapshot(f.options);
    const publication = { ...f.options, ...staged };
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated(_method, target) {
        if (target === f.options.targetPath) {
          throw new Error("synthetic lost effect response");
        }
      },
    });
    await expect(publishPreparedOfflineSessionSnapshot(publication)).rejects.toThrow(
      "synthetic lost effect response",
    );
    __setFsSafeTestHooksForTest();
    const original = await fs.stat(f.options.targetPath);
    await fs.rename(f.sourceRoot, `${f.sourceRoot}-retained`);
    await publishPreparedOfflineSessionSnapshot(publication);
    const after = await fs.stat(f.options.targetPath);
    expect([after.dev, after.ino]).toEqual([original.dev, original.ino]);
  });

  it("does not rerun migration when only a preparation input record exists", async () => {
    const f = await fixture();
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated(_method, target) {
        if (target.endsWith("/preparation.json")) {
          throw new Error("synthetic preparation interruption");
        }
      },
    });
    await expect(prepareOfflineSessionSnapshot(f.options)).rejects.toThrow(
      "synthetic preparation interruption",
    );
    __setFsSafeTestHooksForTest();
    await expect(prepareOfflineSessionSnapshot(f.options)).rejects.toThrow();
    const selected = path.join(
      f.options.privateStateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    expect(readDatabaseSnapshot(selected).version.user_version).toBe(16);
    await expect(fs.stat(f.options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a recorded publication destination outside the independently approved mapping", async () => {
    const f = await fixture();
    const staged = await prepareOfflineSessionSnapshot(f.options);
    const intentPath = path.join(f.options.publicationDir, "proposal", "intent.json");
    const intent = JSON.parse(await fs.readFile(intentPath, "utf8"));
    intent.members[0].targetPath = path.join(f.root, "foreign.sqlite");
    await fs.writeFile(intentPath, `${JSON.stringify(intent)}\n`);
    await expect(
      publishPreparedOfflineSessionSnapshot({ ...f.options, ...staged }),
    ).rejects.toThrow("differs from approved preparation");
    await expect(fs.stat(path.join(f.root, "foreign.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a changed original before creating native private state", async () => {
    const f = await fixture();
    await fs.appendFile(f.options.sourcePath, "unapproved change");
    await expect(prepareOfflineSessionSnapshot(f.options)).rejects.toThrow();
    await expect(fs.stat(f.options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(f.options.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a mismatched independently pinned approval digest", async () => {
    const f = await fixture();
    f.options.approvalManifestSha256 = "e".repeat(64);
    await expect(prepareOfflineSessionSnapshot(f.options)).rejects.toThrow();
    await expect(fs.stat(f.options.privateStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses completed preparation after scratch cleanup and loss of source access", async () => {
    const f = await fixture();
    const staged = await prepareOfflineSessionSnapshot(f.options);
    const publication = { ...f.options, ...staged };
    await publishPreparedOfflineSessionSnapshot(publication);
    const original = await fs.stat(f.options.targetPath);
    await fs.rename(f.sourceRoot, `${f.sourceRoot}-retained`);
    await publishPreparedOfflineSessionSnapshot(publication);
    const after = await fs.stat(f.options.targetPath);
    expect([after.dev, after.ino]).toEqual([original.dev, original.ino]);
    expect(readDatabaseSnapshot(f.options.targetPath).rows).toHaveLength(1);
  });
});
