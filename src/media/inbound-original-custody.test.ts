import { spawn } from "node:child_process";
import crypto, { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fileLock from "../infra/file-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { withChannelReadAuthority } from "../shared/channel-read-authority.js";
import {
  isInboundOriginalDirectory,
  prepareInboundOriginalCustody,
} from "./inbound-original-custody.js";
import {
  cleanOldMedia,
  deleteMediaBuffer,
  getMediaDir,
  readMediaBuffer,
  saveMediaBuffer,
  saveMediaStream,
} from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = Buffer.from("%PDF-1.4\noriginal\n%%EOF\n");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("inbound-custody-"));
  const saved = await saveMediaBuffer(bytes, "application/pdf");
  const prepare = (assertCurrent = () => {}) =>
    prepareInboundOriginalCustody(
      { mediaRoot: getMediaDir(), mediaId: saved.id, digest, sizeBytes: bytes.length },
      assertCurrent,
    );
  return { saved, prepare };
}

describe("inbound original custody", () => {
  it("classifies actual directory identity and leaves distinct case-named buckets independent", async () => {
    await fixture();
    const mediaRoot = getMediaDir();
    const inbound = path.join(mediaRoot, "inbound");
    const alias = path.join(mediaRoot, "native-alias");
    await fs.symlink(inbound, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await isInboundOriginalDirectory(mediaRoot, alias)).toBe(true);
    const custom = path.join(mediaRoot, "custom");
    await fs.mkdir(custom);
    expect(await isInboundOriginalDirectory(mediaRoot, custom)).toBe(false);
    const upper = path.join(mediaRoot, "INBOUND");
    await fs.mkdir(upper, { recursive: true });
    const samePhysicalDirectory = (await fs.realpath(upper)) === (await fs.realpath(inbound));
    expect(await isInboundOriginalDirectory(mediaRoot, upper)).toBe(samePhysicalDirectory);
  });

  it.skipIf(process.platform === "win32")(
    "does not serialize a distinct case-named custom bucket behind inbound custody",
    async (context) => {
      const { prepare } = await fixture();
      const custom = await saveMediaBuffer(bytes, "application/pdf", "INBOUND");
      if (await isInboundOriginalDirectory(getMediaDir(), path.dirname(custom.path))) {
        context.skip();
        return;
      }
      const original = await prepare();
      try {
        await original.withCustody(async (assertCurrent) => {
          const acquire = vi.spyOn(fileLock, "acquireFileLock");
          await deleteMediaBuffer(custom.id, "INBOUND");
          expect(acquire).not.toHaveBeenCalled();
          assertCurrent();
        });
      } finally {
        await original.close();
      }
    },
  );
  it("reads the native original from the captured environment after ambient state root changes", async () => {
    const { saved } = await fixture();
    const capturedEnv = { ...process.env };
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("inbound-other-owner-"));
    await fs.mkdir(path.join(getMediaDir(), "inbound"), { recursive: true });
    const replacement = Buffer.from("different owner's bytes");
    await fs.writeFile(path.join(getMediaDir(), "inbound", saved.id), replacement);
    expect(getMediaDir(capturedEnv)).not.toBe(getMediaDir());
    expect(
      (await readMediaBuffer(saved.id, "inbound", undefined, { env: capturedEnv })).buffer,
    ).toEqual(bytes);
    expect((await readMediaBuffer(saved.id)).buffer).toEqual(replacement);
  });
  it.for(["delete", "prune", "rollback", "case-alias delete"] as const)(
    "keeps another process's original custody through the exact effect while native %s waits",
    async (mutation, context) => {
      const rollback = createDeferred();
      let rolledBack: Promise<void> | undefined;
      let saved: Awaited<ReturnType<typeof saveMediaBuffer>>;
      if (mutation === "rollback") {
        vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("inbound-custody-"));
        const staged = createDeferred<Awaited<ReturnType<typeof saveMediaBuffer>>>();
        rolledBack = withChannelReadAuthority(
          () => {},
          async () => {
            const media = await saveMediaBuffer(bytes, "application/pdf");
            staged.resolve(media);
            await rollback.promise;
            throw new Error("expected rollback");
          },
        ).catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== "expected rollback") {
            throw error;
          }
        });
        saved = await staged.promise;
      } else {
        ({ saved } = await fixture());
      }
      if (mutation === "case-alias delete") {
        const upper = path.join(getMediaDir(), "INBOUND");
        const exists = await fs.stat(upper).catch(() => null);
        if (!exists || !(await isInboundOriginalDirectory(getMediaDir(), upper))) {
          context.skip();
          return;
        }
      }
      const past = (Date.now() - 60_000) / 1000;
      await fs.utimes(saved.path, past, past);
      const entered = createDeferred();
      const deletionAttempted = createDeferred();
      const custodyUrl = resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "inbound-original-custody",
        distWorkerPath: "media/inbound-original-custody.js",
      });
      const destination = path.join(path.dirname(getMediaDir()), "published.pdf");
      const script = `
        import fs from 'node:fs';
        import { prepareInboundOriginalCustody } from ${JSON.stringify(custodyUrl.href)};
        const original = await prepareInboundOriginalCustody(${JSON.stringify({ mediaRoot: getMediaDir(), mediaId: saved.id, digest, sizeBytes: bytes.length })}, () => {});
        let retained;
        try {
          await original.withCustody(async assertOriginalCurrent => {
            retained = assertOriginalCurrent;
            const publish = new Promise(resolve => process.once('message', resolve));
            process.send('entered');
            await publish;
            assertOriginalCurrent();
            fs.writeFileSync(${JSON.stringify(destination)}, original.getBytes());
          });
          let expired = false;
          try { retained(); } catch { expired = true; }
          if (!expired) throw new Error('Retained original custody remained live');
        } finally { await original.close(); }
        process.disconnect();
      `;
      const child = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(custodyUrl).slice(0, -1), "--input-type=module", "-e", script],
        { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("message", (message) => {
        if (message === "entered") {
          entered.resolve();
        }
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", (error) => {
          entered.reject(error);
          reject(error);
        });
        child.once("close", (code) => {
          entered.reject(new Error(stderr || "Custody child exited"));
          resolve(code);
        });
      });
      const acquire = fileLock.acquireFileLock;
      vi.spyOn(fileLock, "acquireFileLock").mockImplementation((target, options) => {
        deletionAttempted.resolve();
        return acquire(target, options);
      });
      let deletion: Promise<void> | undefined;
      let published = false;
      try {
        await entered.promise;
        if (mutation === "rollback") {
          rollback.resolve();
        }
        deletion =
          mutation === "rollback"
            ? rolledBack
            : mutation === "delete" || mutation === "case-alias delete"
              ? deleteMediaBuffer(
                  saved.id,
                  mutation === "case-alias delete" ? "INBOUND" : "inbound",
                )
              : cleanOldMedia(1000, { recursive: true, pruneEmptyDirs: true });
        await deletionAttempted.promise;
        expect(await fs.readFile(saved.path)).toEqual(bytes);
        published = true;
        child.send("publish");
        await deletion;
        expect(await exited, stderr).toBe(0);
        await expect(fs.stat(saved.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(destination)).toEqual(bytes);
      } finally {
        if (!published && child.connected) {
          child.send("publish", () => {});
        }
        rollback.resolve();
        await Promise.allSettled([exited, deletion]);
      }
    },
  );

  it.each(["inbound", "outbound", "inbound staging"] as const)(
    "process exit retains inbound finals for custody-aware prune and preserves %s cleanup policy",
    async (kind) => {
      const subdir = kind === "outbound" ? "outbound" : "inbound";
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("inbound-exit-custody-"));
      const custodyUrl = resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "inbound-original-custody",
        distWorkerPath: "media/inbound-original-custody.js",
      });
      const suffix = path.extname(custodyUrl.pathname);
      const storeUrl = new URL(`./store${suffix}`, custodyUrl);
      const authorityUrl = new URL(`../shared/channel-read-authority${suffix}`, custodyUrl);
      const staged = createDeferred<string>();
      const script = `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { saveMediaBuffer, saveMediaStream, getMediaDir } from ${JSON.stringify(storeUrl.href)};
        import { withChannelReadAuthority } from ${JSON.stringify(authorityUrl.href)};
        process.once('message', () => process.exit(0));
        await withChannelReadAuthority(() => {}, async () => {
          if (${JSON.stringify(kind)} === 'inbound staging') {
            await saveMediaStream((async function* () {
              yield Buffer.from(${JSON.stringify(bytes.toString("base64"))}, 'base64');
              const directory = path.join(getMediaDir(), 'inbound');
              const names = await fs.readdir(directory);
              if (names.length !== 1 || !names[0].endsWith('.tmp')) throw new Error('Expected owned staging file');
              process.send(path.join(directory, names[0]));
              await new Promise(() => {});
            })(), 'application/pdf');
            return;
          }
          const saved = await saveMediaBuffer(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, 'base64'), 'application/pdf', ${JSON.stringify(subdir)});
          process.send(saved.path);
          await new Promise(() => {});
        });
      `;
      const child = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(custodyUrl).slice(0, -1), "--input-type=module", "-e", script],
        { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("message", (message) => {
        if (typeof message === "string") {
          staged.resolve(message);
        }
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", (error) => {
          staged.reject(error);
          reject(error);
        });
        child.once("close", (code) => {
          staged.reject(new Error(stderr || "Exit child closed"));
          resolve(code);
        });
      });
      try {
        const savedPath = await staged.promise;
        child.send("exit");
        expect(await exited, stderr).toBe(0);
        if (kind === "inbound") {
          expect(await fs.readFile(savedPath)).toEqual(bytes);
          await fs.utimes(savedPath, 1, 1);
          await cleanOldMedia(1000, { recursive: true });
        }
        await expect(fs.stat(savedPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (child.connected) {
          child.send("exit", () => {});
        }
        await Promise.allSettled([exited]);
      }
    },
  );

  it.each([
    "removed",
    "equal-byte replacement",
    "changed bytes",
    "inbound directory replacement",
  ] as const)("refuses a %s after staging before the effect", async (change) => {
    const { saved, prepare } = await fixture();
    const original = await prepare();
    const copy = original.getBytes();
    copy.fill(0);
    expect(original.getBytes()).toEqual(bytes);
    if (change === "removed") {
      await deleteMediaBuffer(saved.id);
    } else if (change === "inbound directory replacement") {
      await fs.rename(path.dirname(saved.path), `${path.dirname(saved.path)}-retired`);
      await fs.mkdir(path.dirname(saved.path));
      await fs.writeFile(saved.path, bytes);
    } else if (change === "equal-byte replacement") {
      await fs.rename(saved.path, `${saved.path}-retired`);
      await fs.writeFile(saved.path, bytes);
    } else {
      await fs.writeFile(saved.path, Buffer.alloc(bytes.length, 120));
    }
    const effect = vi.fn();
    try {
      await expect(
        original.withCustody(async (assertCurrent) => {
          assertCurrent();
          effect();
        }),
      ).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
    } finally {
      await original.close();
    }
  });

  it("revokes retained custody before joining an already-entered source operation", async () => {
    const { prepare } = await fixture();
    const original = await prepare();
    const entered = createDeferred();
    const release = createDeferred();
    const effect = vi.fn();
    const work = original.withCustody(async (assertCurrent) => {
      entered.resolve();
      await release.promise;
      assertCurrent();
      effect();
    });
    const refusal = expect(work).rejects.toThrow("custody is closed");
    await entered.promise;
    const closed = original.close();
    expect(() => original.getBytes()).toThrow("custody is closed");
    release.resolve();
    await refusal;
    await closed;
    expect(effect).not.toHaveBeenCalled();
  });

  it("rejects foreign links and out-of-bounds originals without admitting an effect", async () => {
    const { saved } = await fixture();
    const input = { mediaRoot: getMediaDir(), mediaId: saved.id, digest, sizeBytes: bytes.length };
    await expect(
      prepareInboundOriginalCustody({ ...input, maxBytes: 5 * 1024 * 1024 + 1 }, () => {}),
    ).rejects.toThrow("byte bound");
    await fs.link(saved.path, `${saved.path}-alias`);
    await expect(prepareInboundOriginalCustody(input, () => {})).rejects.toThrow("unsafe");
  });

  it.for(["buffer", "stream", "case-alias buffer", "case-alias stream"] as const)(
    "refuses UUID collision replacement by a fresh %s upload",
    async (kind, context) => {
      await fixture();
      const alias = kind.startsWith("case-alias");
      if (alias) {
        const upper = path.join(getMediaDir(), "INBOUND");
        const exists = await fs.stat(upper).catch(() => null);
        if (!exists || !(await isInboundOriginalDirectory(getMediaDir(), upper))) {
          context.skip();
          return;
        }
      }
      const randomUUID = "11111111-1111-4111-8111-111111111111";
      vi.spyOn(crypto, "randomUUID").mockReturnValue(randomUUID);
      const first = await saveMediaBuffer(bytes, "application/pdf");
      const collision = kind.endsWith("buffer")
        ? saveMediaBuffer(
            Buffer.from("replacement"),
            "application/pdf",
            alias ? "INBOUND" : "inbound",
          )
        : saveMediaStream(
            (async function* () {
              yield Buffer.from("replacement");
            })(),
            "application/pdf",
            alias ? "INBOUND" : "inbound",
          );
      await expect(collision).rejects.toThrow();
      expect(await fs.readFile(first.path)).toEqual(bytes);
    },
  );
});
