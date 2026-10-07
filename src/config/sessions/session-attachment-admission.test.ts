import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as fileLock from "../../infra/file-lock.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { readPersistedMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { getMediaDir, MEDIA_MAX_BYTES, saveMediaBuffer } from "../../media/store.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import { readSessionTranscriptBoundedMessageTailPage } from "./session-accessor.sqlite-active-events.js";
import * as entryAdmission from "./session-accessor.sqlite-entry-admission.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { prepareAcceptedSessionAttachmentAdmission } from "./session-attachment-admission.js";
import type {
  AcceptedSessionAttachmentAdmission,
  AcceptedSessionAttachmentSelection,
} from "./session-attachment-admission.types.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const caps: AcceptedSessionAttachmentAdmission[] = [];
let root: string;
let current: boolean;
let fixtureSequence = 0;
beforeAll(() => {
  root = tempDirs.make("openclaw-accepted-attachment-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  current = true;
});
afterEach(async () => {
  await Promise.all(caps.splice(0).map((cap) => cap.close()));
  vi.restoreAllMocks();
});

async function fixture(
  params: {
    role?: "user" | "assistant";
    sparse?: boolean;
    path?: boolean;
    bytes?: Buffer;
    hidden?: "display" | "visibility";
    contentType?: string;
    kind?: MediaFact["kind"];
  } = {},
) {
  const bytes = params.bytes ?? Buffer.from("Accepted original attachment");
  const media = await saveMediaBuffer(
    bytes,
    params.contentType ?? "text/plain",
    "inbound",
    Math.max(bytes.length, MEDIA_MAX_BYTES),
    params.contentType === "image/png"
      ? "accepted.png"
      : params.contentType === "application/pdf"
        ? "accepted.pdf"
        : "accepted.txt",
  );
  const mediaRef = `media://inbound/${media.id}`;
  const incarnation = ++fixtureSequence;
  const scope = {
    agentId: "main",
    sessionKey: `agent:main:accepted-attachment-${incarnation}`,
    sessionId: `accepted-source-${incarnation}`,
    env: { ...process.env },
  };
  const fact = {
    ...(params.path ? { path: media.path } : { url: mediaRef }),
    contentType: media.contentType,
    ...(params.kind ? { kind: params.kind } : {}),
  };
  await persistSessionTranscriptTurn(scope, {
    messages: [
      transcriptMessage("selected", null, {
        role: params.role ?? "user",
        content: "Accepted",
        ...(params.hidden === "display" ? { display: false } : {}),
        __openclaw: {
          media: params.sparse ? [null, fact] : [fact],
          ...(params.hidden === "visibility" ? { visibility: { display: false } } : {}),
        },
      }),
    ],
    touchSessionEntry: false,
  });
  runOpenClawAgentWriteTransaction(
    (owner) =>
      writeSessionEntry(owner, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 }),
    scope,
  );
  await waitForSessionTranscriptIndexReconcile(scope);
  const page = readSessionTranscriptBoundedMessageTailPage(scope, {
    maxMessages: 1,
    maxBytes: 1024 * 1024,
    offset: 0,
  });
  if (!page.snapshot.generation) {
    throw new Error("Fixture projection is unavailable");
  }
  const selection: AcceptedSessionAttachmentSelection = {
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    entryId: "selected",
    generation: page.snapshot.generation,
    mediaIndex: params.sparse ? 1 : 0,
    mediaRef,
  };
  const authority = {
    env: scope.env,
    assertCurrent(observed: AcceptedSessionAttachmentSelection) {
      expect(observed).toEqual(selection);
      if (!current) {
        throw new Error("Native invocation revoked");
      }
    },
  };
  const persistedMessage = asOptionalRecord(asOptionalRecord(page.events[0]?.event)?.message);
  return { bytes, media, scope, selection, authority, persistedMessage };
}

it.each([false, true])(
  "prepares an exact accepted original and publishes a synchronous effect from a persisted path=%s",
  async (usePath) => {
    const source = await fixture({ path: usePath });
    const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
    caps.push(cap);
    expect(cap.originalDigest).toBe(
      `sha256:${createHash("sha256").update(source.bytes).digest("hex")}`,
    );
    expect(cap.sizeBytes).toBe(source.bytes.length);
    const copy = cap.getOriginalBytes();
    copy.fill(0);
    expect(cap.getOriginalBytes()).toEqual(source.bytes);
    const destination = path.join(root, "published.txt");
    const staging = cap.getOriginalBytes();
    await cap.publish(() => fs.writeFileSync(destination, staging));
    expect(fs.readFileSync(destination)).toEqual(source.bytes);
    expect(fs.readFileSync(source.media.path)).toEqual(source.bytes);
    await expect(
      cap.publish(() => {
        throw new Error("Must not run twice");
      }),
    ).rejects.toMatchObject({ effectState: "not-entered" });
    expect(() => cap.getOriginalBytes()).toThrow("closed");
  },
);

it("preserves sparse media indices instead of silently selecting a nearby attachment", async () => {
  const source = await fixture({ sparse: true });
  await expect(
    prepareAcceptedSessionAttachmentAdmission(
      { ...source.selection, mediaIndex: 0 },
      { ...source.authority, assertCurrent() {} },
    ),
  ).rejects.toThrow("index is unavailable");
  const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
  caps.push(cap);
  expect(cap.getOriginalBytes()).toEqual(source.bytes);
});

it("refuses an assistant source and mismatched entry attachment references", async () => {
  const source = await fixture({ role: "assistant" });
  await expect(
    prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority),
  ).rejects.toThrow("accepted user message");
});

it("refuses a reference belonging to another inbound attachment", async () => {
  const source = await fixture();
  await expect(
    prepareAcceptedSessionAttachmentAdmission(
      { ...source.selection, mediaRef: "media://inbound/other.txt" },
      { ...source.authority, assertCurrent() {} },
    ),
  ).rejects.toThrow("exact persisted inbound fact");
});

it.each(["display", "visibility"] as const)(
  "refuses a selected USER message hidden by %s",
  async (hidden) => {
    const source = await fixture({ hidden });
    await expect(
      prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority),
    ).rejects.toThrow("hidden from its selected surface");
  },
);

it("rejects asynchronous authority before invoking it or opening the native source", async () => {
  const source = await fixture();
  let calls = 0;
  const guard = async () => {
    calls += 1;
  };
  await expect(
    prepareAcceptedSessionAttachmentAdmission(source.selection, {
      ...source.authority,
      assertCurrent: guard,
    }),
  ).rejects.toThrow("synchronous captured native authority");
  expect(calls).toBe(0);
  await expect(
    prepareAcceptedSessionAttachmentAdmission(source.selection, {
      ...source.authority,
      assertCurrent: () => Promise.resolve(),
    }),
  ).rejects.toThrow("authority must be synchronous");
});

it("refuses a changed projection generation without restoring history", async () => {
  const source = await fixture();
  await expect(
    prepareAcceptedSessionAttachmentAdmission(
      { ...source.selection, generation: "retired" },
      { ...source.authority, assertCurrent() {} },
    ),
  ).rejects.toThrow("projection changed");
});

it("retains the original native source across admission handoff and refuses an identical replacement", async () => {
  const source = await fixture();
  const database = openOpenClawAgentDatabase(source.scope);
  const originalIdentity = readDatabasePathIdentitySync(database.path);
  const clonePath = path.join(root, "identical-source-clone.sqlite");
  const retainedPath = path.join(root, "retained-source.sqlite");
  database.db.prepare("VACUUM INTO ?").run(clonePath);
  expect(readDatabasePathIdentitySync(clonePath).key).not.toBe(originalIdentity.key);
  const load = entryAdmission.loadSessionEntryForAdmission;
  let reads = 0;
  let swapped = false;
  vi.spyOn(entryAdmission, "loadSessionEntryForAdmission").mockImplementation(async (...args) => {
    const owner = await load(...args);
    if (++reads !== 1) {
      return owner;
    }
    return {
      ...owner,
      databaseClaim: {
        ...owner.databaseClaim,
        async release() {
          await owner.databaseClaim.release();
          fs.renameSync(database.path, retainedPath);
          fs.renameSync(clonePath, database.path);
          swapped = true;
        },
      },
    };
  });
  const destination = path.join(root, "must-not-publish-replacement.txt");
  const effect = vi.fn(() => fs.writeFileSync(destination, source.bytes));
  try {
    const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
    caps.push(cap);
    expect(swapped).toBe(true);
    expect(readDatabasePathIdentitySync(database.path).key).not.toBe(originalIdentity.key);
    await expect(cap.publish(effect)).rejects.toMatchObject({ effectState: "not-entered" });
    expect(effect).not.toHaveBeenCalled();
    expect(fs.existsSync(destination)).toBe(false);
  } finally {
    if (swapped) {
      fs.renameSync(database.path, clonePath);
      fs.renameSync(retainedPath, database.path);
    }
  }
});

it("preserves the incognito prohibition and requires captured authority", async () => {
  const source = await fixture();
  await expect(
    prepareAcceptedSessionAttachmentAdmission(
      { ...source.selection, sessionKey: "agent:main:dashboard:incognito-source" },
      source.authority,
    ),
  ).rejects.toThrow("Incognito");
  await expect(
    prepareAcceptedSessionAttachmentAdmission(
      source.selection,
      JSON.parse('{"assertCurrent":true}'),
    ),
  ).rejects.toThrow("captured native authority");
});

it("refuses originals over the native 5 MiB cap before exposing bytes or an effect", async () => {
  const source = await fixture({ bytes: Buffer.alloc(MEDIA_MAX_BYTES + 1) });
  await expect(
    prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority),
  ).rejects.toThrow("maximum is 5242880 bytes");
});

it("revokes publication before its effect if captured native authority is retired", async () => {
  const source = await fixture();
  const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
  caps.push(cap);
  current = false;
  const effect = vi.fn();
  await expect(cap.publish(effect)).rejects.toMatchObject({ effectState: "not-entered" });
  expect(effect).not.toHaveBeenCalled();
});

it("preserves entered effect state when a synchronous publication rolls itself back and throws undefined", async () => {
  const source = await fixture();
  const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
  caps.push(cap);
  const destination = path.join(root, "rolled-back.txt");
  await expect(
    cap.publish(() => {
      fs.writeFileSync(destination, "tentative");
      fs.unlinkSync(destination);
      throw undefined;
    }),
  ).rejects.toMatchObject({
    code: "accepted_attachment_publication_failed",
    effectState: "entered",
  });
  expect(fs.existsSync(destination)).toBe(false);
  expect(fs.readFileSync(source.media.path)).toEqual(source.bytes);
  expect(getMediaDir(source.authority.env)).toBe(path.join(root, "media"));
});

it("rejects a plain Promise-returning publication as entered without an unhandled rejection", async () => {
  const source = await fixture();
  const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
  caps.push(cap);
  await expect(
    cap.publish(() => Promise.reject(new Error("Invalid asynchronous effect"))),
  ).rejects.toMatchObject({ effectState: "entered" });
  expect(fs.readFileSync(source.media.path)).toEqual(source.bytes);
});

it("preserves a completed destination when native custody release reports failure after releasing", async () => {
  const source = await fixture();
  const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
  caps.push(cap);
  const acquire = fileLock.acquireFileLock;
  let released = false;
  vi.spyOn(fileLock, "acquireFileLock").mockImplementation(async (target, options) => {
    const lock = await acquire(target, options);
    return {
      ...lock,
      async release() {
        await lock.release();
        released = true;
        throw new Error("Injected post-release settlement failure");
      },
    };
  });
  const destination = path.join(root, "completed-before-release-error.txt");
  const staging = cap.getOriginalBytes();
  await expect(cap.publish(() => fs.writeFileSync(destination, staging))).rejects.toMatchObject({
    effectState: "completed",
  });
  expect(released).toBe(true);
  expect(fs.readFileSync(destination)).toEqual(source.bytes);
  expect(fs.readFileSync(source.media.path)).toEqual(source.bytes);
  await expect(cap.publish(() => fs.unlinkSync(destination))).rejects.toMatchObject({
    effectState: "not-entered",
  });
  expect(fs.readFileSync(destination)).toEqual(source.bytes);
});

it.each([
  {
    kind: "image" as const,
    contentType: "image/png",
    usePath: true,
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
      "base64",
    ),
  },
  {
    kind: "document" as const,
    contentType: "application/pdf",
    usePath: false,
    bytes: Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    ),
  },
])(
  "publishes the exact accepted $contentType original with native persisted metadata",
  async ({ kind, contentType, usePath, bytes }) => {
    const source = await fixture({ bytes, contentType, kind, path: usePath });
    expect(source.media.contentType).toBe(contentType);
    expect(source.persistedMessage?.role).toBe("user");
    expect(readPersistedMediaFacts(source.persistedMessage ?? {})?.[0]).toMatchObject({
      contentType,
      kind,
    });
    const cap = await prepareAcceptedSessionAttachmentAdmission(source.selection, source.authority);
    caps.push(cap);
    expect(cap.originalDigest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(cap.sizeBytes).toBe(bytes.length);
    const staging = cap.getOriginalBytes();
    expect(staging).toEqual(bytes);
    const destination = path.join(root, kind === "image" ? "published.png" : "published.pdf");
    await cap.publish(() => fs.writeFileSync(destination, staging));
    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fs.readFileSync(source.media.path)).toEqual(bytes);
  },
);
