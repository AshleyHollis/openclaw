import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  publishDurableDirectoryNoReplace,
  stageDurableFileInDirectory,
} from "../plugin-sdk/file-access-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function directoryFixture() {
  const parent = tempDirs.make("openclaw-durable-publication-");
  const stagedDir = path.join(parent, "staged");
  const targetDir = path.join(parent, "target");
  fs.mkdirSync(stagedDir, { mode: 0o700 });
  fs.writeFileSync(path.join(stagedDir, "content"), "complete");
  const { dev, ino } = fs.lstatSync(stagedDir, { bigint: true });
  return { parent, stagedDir, targetDir, expectedIdentity: { dev, ino } };
}

// Native helper absence is a qualification failure, never a mock or silent skip.
describe("retained SDK native publication", () => {
  it("publishes complete staged bytes and closes cleanup without removing the final file", async () => {
    const directory = tempDirs.make("openclaw-durable-file-");
    const staged = await stageDurableFileInDirectory({
      directory,
      content: "complete",
      mode: 0o600,
    });
    try {
      expect(
        fs.lstatSync(path.join(directory, staged.receipt.temporaryBasename), { bigint: true }).ino,
      ).toBe(staged.receipt.identity.ino);
      const published = staged.publish("final", { overwrite: false });
      // The Promise wrapper must not yield before its publication effect.
      expect(fs.readFileSync(path.join(directory, "final"), "utf8")).toBe("complete");
      await expect(published).resolves.toMatchObject({ status: "published", overwrite: false });
    } finally {
      await expect(staged.cleanup()).resolves.toMatchObject({
        status: "not-needed",
        resources: "closed",
      });
    }
    expect(fs.readdirSync(directory)).toEqual(["final"]);
    await expect(staged.assertCurrent()).rejects.toThrow();
  });

  it("never clobbers an existing file and preserves the stage after indeterminate publication", async () => {
    const directory = tempDirs.make("openclaw-durable-file-collision-");
    fs.writeFileSync(path.join(directory, "final"), "existing");
    const staged = await stageDurableFileInDirectory({ directory, content: "new" });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    try {
      await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
        code: "already-exists",
        details: {
          phase: "publish",
          publication: { status: "indeterminate", basename: "final", overwrite: false },
        },
      });
    } finally {
      // Ordinary native errno cannot prove a remote rename did not commit.
      await expect(staged.cleanup()).resolves.toMatchObject({
        status: "preserved",
        resources: "closed",
        publication: { status: "indeterminate", basename: "final", overwrite: false },
      });
    }
    expect(fs.readdirSync(directory).toSorted()).toEqual(
      [staged.receipt.temporaryBasename, "final"].toSorted(),
    );
    const { dev, ino } = fs.lstatSync(temporary, { bigint: true });
    expect({ dev, ino }).toEqual({
      dev: staged.receipt.identity.dev,
      ino: staged.receipt.identity.ino,
    });
    expect(fs.readFileSync(temporary, "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(directory, "final"), "utf8")).toBe("existing");
    await expect(staged.assertCurrent()).rejects.toThrow();
  });

  it("removes only its own unattempted stage and closes cleanup", async () => {
    const directory = tempDirs.make("openclaw-durable-file-abort-");
    fs.writeFileSync(path.join(directory, "sentinel"), "unrelated");
    const staged = await stageDurableFileInDirectory({ directory, content: "owned" });
    await expect(staged.cleanup()).resolves.toMatchObject({
      status: "removed",
      resources: "closed",
      publication: { status: "not-published" },
    });
    expect(fs.readdirSync(directory)).toEqual(["sentinel"]);
    expect(fs.readFileSync(path.join(directory, "sentinel"), "utf8")).toBe("unrelated");
    await expect(staged.assertCurrent()).rejects.toThrow();
  });

  it("rejects a replaced stage and preserves the unrelated replacement during cleanup", async () => {
    const directory = tempDirs.make("openclaw-durable-stage-replaced-");
    const staged = await stageDurableFileInDirectory({ directory, content: "owned" });
    const temporary = path.join(directory, staged.receipt.temporaryBasename);
    fs.renameSync(temporary, path.join(directory, "retained-original"));
    fs.writeFileSync(temporary, "unrelated");
    try {
      await expect(staged.assertCurrent()).rejects.toThrow();
      await expect(staged.publish("final", { overwrite: false })).rejects.toThrow();
    } finally {
      await expect(staged.cleanup()).resolves.toMatchObject({
        status: "preserved",
        resources: "closed",
      });
    }
    expect(fs.readFileSync(temporary, "utf8")).toBe("unrelated");
    expect(fs.existsSync(path.join(directory, "final"))).toBe(false);
  });

  it("synchronously publishes an exact sibling identity and syncs its parent", () => {
    const fixture = directoryFixture();
    const sync = vi.spyOn(fs, "fsyncSync");
    const receipt = publishDurableDirectoryNoReplace(fixture);
    expect(receipt).toEqual({
      status: "published",
      targetDir: fixture.targetDir,
      identity: fixture.expectedIdentity,
    });
    expect(fs.lstatSync(fixture.targetDir, { bigint: true }).ino).toBe(
      fixture.expectedIdentity.ino,
    );
    expect(fs.readFileSync(path.join(fixture.targetDir, "content"), "utf8")).toBe("complete");
    expect(fs.existsSync(fixture.stagedDir)).toBe(false);
    expect(sync).toHaveBeenCalledOnce();
  });

  it.each(["directory", "file", "symlink"])("preserves an existing %s target", (kind) => {
    const fixture = directoryFixture();
    if (kind === "directory") {
      fs.mkdirSync(fixture.targetDir);
    } else if (kind === "file") {
      fs.writeFileSync(fixture.targetDir, "existing");
    } else {
      fs.symlinkSync(fixture.stagedDir, fixture.targetDir);
    }
    const before = fs.lstatSync(fixture.targetDir, { bigint: true });
    expect(() => publishDurableDirectoryNoReplace(fixture)).toThrow(
      expect.objectContaining({ code: "already-exists" }),
    );
    expect(fs.lstatSync(fixture.targetDir, { bigint: true }).ino).toBe(before.ino);
    expect(fs.lstatSync(fixture.stagedDir, { bigint: true }).ino).toBe(
      fixture.expectedIdentity.ino,
    );
  });

  it("rechecks identity after the synchronous authority guard", () => {
    const fixture = directoryFixture();
    expect(() =>
      publishDurableDirectoryNoReplace({
        ...fixture,
        assertBeforeMutation: () => {
          fs.renameSync(fixture.stagedDir, path.join(fixture.parent, "original"));
          fs.mkdirSync(fixture.stagedDir);
        },
      }),
    ).toThrow();
    expect(fs.existsSync(fixture.targetDir)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.parent, "original", "content"), "utf8")).toBe(
      "complete",
    );
  });

  it("rejects replacement of the retained parent by the authority guard", () => {
    const fixture = directoryFixture();
    const displaced = `${fixture.parent}-displaced`;
    try {
      expect(() =>
        publishDurableDirectoryNoReplace({
          ...fixture,
          assertBeforeMutation: () => {
            fs.renameSync(fixture.parent, displaced);
            fs.mkdirSync(fixture.parent);
            fs.mkdirSync(fixture.stagedDir);
          },
        }),
      ).toThrow();
      expect(fs.existsSync(fixture.targetDir)).toBe(false);
      expect(fs.existsSync(path.join(displaced, "target"))).toBe(false);
      expect(fs.readFileSync(path.join(displaced, "staged", "content"), "utf8")).toBe("complete");
    } finally {
      fs.rmSync(displaced, { recursive: true, force: true });
    }
  });

  it("does not publish after authority rejection", () => {
    const fixture = directoryFixture();
    const refusal = new Error("authority closed");
    expect(() =>
      publishDurableDirectoryNoReplace({
        ...fixture,
        assertBeforeMutation: () => {
          throw refusal;
        },
      }),
    ).toThrow(refusal);
    expect(fs.existsSync(fixture.targetDir)).toBe(false);
    expect(fs.lstatSync(fixture.stagedDir, { bigint: true }).ino).toBe(
      fixture.expectedIdentity.ino,
    );
  });

  it.each([
    { name: "async callback", guard: async () => undefined },
    {
      name: "rejected async callback",
      guard: async () => {
        throw new Error("authority closed");
      },
    },
    { name: "rejected Promise", guard: () => Promise.reject(new Error("authority closed")) },
    {
      name: "rejecting thenable",
      // A foreign thenable exposes its Promise protocol dynamically.
      guard: () =>
        new Proxy(
          {},
          {
            get: (_target, property) =>
              property === "then"
                ? (_resolve: unknown, reject: (reason: Error) => void) =>
                    reject(new Error("authority closed"))
                : undefined,
          },
        ),
    },
    {
      name: "generator callback",
      guard: function* rejectedGeneratorGuard() {
        yield* [];
        throw new Error("authority closed");
      },
    },
  ])("rejects $name before publication and retains the staged identity", async ({ guard }) => {
    const fixture = directoryFixture();
    const sync = vi.spyOn(fs, "fsyncSync");
    expect(() =>
      // Deliberately violate the synchronous callback contract at the runtime boundary.
      Reflect.apply(publishDurableDirectoryNoReplace, undefined, [
        { ...fixture, assertBeforeMutation: guard },
      ]),
    ).toThrow(new TypeError("assertBeforeMutation must be synchronous"));
    expect(fs.existsSync(fixture.targetDir)).toBe(false);
    const { dev, ino } = fs.lstatSync(fixture.stagedDir, { bigint: true });
    expect({ dev, ino }).toEqual(fixture.expectedIdentity);
    expect(fs.readFileSync(path.join(fixture.stagedDir, "content"), "utf8")).toBe("complete");
    expect(sync).not.toHaveBeenCalled();
    // Let rejection handling settle: Vitest must not observe an unhandled rejection.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(fs.existsSync(fixture.targetDir)).toBe(false);
  });

  it("rejects non-siblings without mutating the stage", () => {
    const fixture = directoryFixture();
    expect(() =>
      publishDurableDirectoryNoReplace({
        ...fixture,
        targetDir: path.join(fixture.stagedDir, "child"),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-path" }));
    expect(fs.lstatSync(fixture.stagedDir, { bigint: true }).ino).toBe(
      fixture.expectedIdentity.ino,
    );
  });

  it("reports publication when parent close fails after physically closing the descriptor", () => {
    const fixture = directoryFixture();
    const closeNative = fs.closeSync;
    const failure = new Error("close failed after close");
    vi.spyOn(fs, "closeSync").mockImplementationOnce((fd) => {
      closeNative(fd);
      throw failure;
    });
    expect(() => publishDurableDirectoryNoReplace(fixture)).toThrow(
      expect.objectContaining({
        cause: failure,
        details: { publication: "published" },
      }),
    );
    expect(fs.lstatSync(fixture.targetDir, { bigint: true }).ino).toBe(
      fixture.expectedIdentity.ino,
    );
  });

  it("retains an honest publication receipt after a parent-sync failure", () => {
    const fixture = directoryFixture();
    const failure = new Error("sync failed");
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => publishDurableDirectoryNoReplace(fixture)).toThrow(
      expect.objectContaining({
        cause: failure,
        details: { publication: "published" },
      }),
    );
    expect(fs.lstatSync(fixture.targetDir, { bigint: true }).ino).toBe(
      fixture.expectedIdentity.ino,
    );
    expect(fs.existsSync(fixture.stagedDir)).toBe(false);
  });
});
