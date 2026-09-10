import { zstdCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { captureOfflineSessionArchive } from "../../scripts/lib/offline-session-archives.mts";

it.each([false, true])(
  "preserves every archived record through media conversion (compressed=%s)",
  (compressed) => {
    const encode = (value: string) =>
      compressed ? zstdCompressSync(Buffer.from(value)) : Buffer.from(value);
    const header = '{"type":"session","id":"archive-a","opaque":{"keep":true}}';
    const source = `${header}\n{"type":"message","id":"event-a","parentId":null,"message":{"role":"user","content":"Keep this history","MediaPath":"/fictional/bill.pdf"}}\n`;
    const expected = `${header}\n{"type":"message","id":"event-a","parentId":null,"message":{"role":"user","content":"Keep this history","__openclaw":{"media":[{"path":"/fictional/bill.pdf"}]}}}\n`;
    const accounting = captureOfflineSessionArchive(encode(source), { compressed });
    expect(() => accounting.assertPrepared(encode(expected))).not.toThrow();
    for (const changed of [
      expected.replace("Keep this history", "Changed history"),
      expected.replace('"id":"event-a"', '"id":"event-b"'),
      expected.replace('"parentId":null', '"parentId":"another-event"'),
      expected.replace('"keep":true', '"keep":false'),
      expected.trimEnd(),
      expected.trimEnd().split("\n").toReversed().join("\n") + "\n",
      expected + '{"type":"opaque","id":"extra"}\n',
    ]) {
      expect(() => accounting.assertPrepared(encode(changed))).toThrow();
    }
  },
);

it.each([false, true])(
  "retains unchanged encoding and permits only a terminal NUL repair (compressed=%s)",
  (compressed) => {
    const encode = (value: string) =>
      compressed ? zstdCompressSync(Buffer.from(value)) : Buffer.from(value);
    for (const original of [
      "",
      '{ "type": "session", "id": "a" }',
      '{ "type": "session", "id": "a" }\r\n',
    ]) {
      const bytes = encode(original);
      const unchanged = captureOfflineSessionArchive(bytes, { compressed });
      expect(() => unchanged.assertPrepared(bytes)).not.toThrow();
      if (original !== "") {
        const repaired = captureOfflineSessionArchive(encode(original + "\0\0"), { compressed });
        expect(() => repaired.assertPrepared(bytes)).not.toThrow();
        expect(() => repaired.assertPrepared(encode(original + "\0"))).toThrow();
        expect(() => repaired.assertPrepared(encode(original.trimEnd() + "\n"))).toThrow();
      }
      if (compressed) {
        // A concatenated empty zstd frame changes encoding, not decoded content.
        expect(() =>
          unchanged.assertPrepared(Buffer.concat([bytes, zstdCompressSync(Buffer.alloc(0))])),
        ).toThrow();
      }
    }
  },
);

it.each([false, true])(
  "refuses malformed framing, invalid UTF-8 and unbounded expansion (compressed=%s)",
  (compressed) => {
    const encode = (bytes: Buffer) => (compressed ? zstdCompressSync(bytes) : bytes);
    for (const original of ["\0\0", "\n", "{}\n\n", "{", "{}\0\n", "   ", "\ufeff{}", '"\0"']) {
      expect(() =>
        captureOfflineSessionArchive(encode(Buffer.from(original)), { compressed }),
      ).toThrow();
    }
    expect(() =>
      captureOfflineSessionArchive(encode(Buffer.from([0x22, 0xff, 0x22])), { compressed }),
    ).toThrow();
    const expanded = encode(
      Buffer.from(JSON.stringify({ type: "session", text: "x".repeat(4096) })),
    );
    expect(() =>
      captureOfflineSessionArchive(expanded, { compressed, maxDecodedBytes: 64 }),
    ).toThrow();
    for (const maxDecodedBytes of [0, -1, Infinity, Number.NaN, 1.5, 256 * 1024 * 1024 + 1]) {
      expect(() =>
        captureOfflineSessionArchive(encode(Buffer.from("{}")), { compressed, maxDecodedBytes }),
      ).toThrow();
    }
  },
);

it.each([false, true])(
  "bounds converted content and freezes its decoding contract (compressed=%s)",
  (compressed) => {
    const encode = (value: string) =>
      compressed ? zstdCompressSync(Buffer.from(value)) : Buffer.from(value);
    const original = '{"type":"message","message":{"role":"user","MediaPath":"x"}}';
    const expected =
      '{"type":"message","message":{"role":"user","__openclaw":{"media":[{"path":"x"}]}}}';
    expect(() =>
      captureOfflineSessionArchive(encode(original), {
        compressed,
        maxDecodedBytes: Buffer.byteLength(original),
      }),
    ).toThrow("converted archive");
    const options = { compressed, maxDecodedBytes: 1024 };
    const accounting = captureOfflineSessionArchive(encode(original), options);
    options.compressed = !compressed;
    options.maxDecodedBytes = 1;
    expect(() => accounting.assertPrepared(encode(expected))).not.toThrow();
    expect(() => accounting.assertPrepared(encode('"' + "x".repeat(2048) + '"'))).toThrow();
  },
);

it.each([false, true])(
  "refuses lossy JSON reserialization without rejecting byte-preserved history (compressed=%s)",
  (compressed) => {
    const encode = (value: string) =>
      compressed ? zstdCompressSync(Buffer.from(value)) : Buffer.from(value);
    const media = '{"type":"message","message":{"role":"user","MediaPath":"x"}}\n';
    for (const opaque of [
      '{"counter":9007199254740993}',
      '{"counter":1e400}',
      '{"fraction":1.0000000000000001}',
      '{"x":1,"x":2}',
      '{"x":1,"\\u0078":2}',
      '{"nested":[{"x":1,"x":2}]}',
      '{"zero":-0}',
    ]) {
      const bytes = encode(opaque + "\n");
      expect(() =>
        captureOfflineSessionArchive(bytes, { compressed }).assertPrepared(bytes),
      ).not.toThrow();
      expect(() =>
        captureOfflineSessionArchive(encode(opaque + "\n" + media), { compressed }),
      ).toThrow("lossy JSON");
    }
    const exact =
      '{"values":[9007199254740992,1.2300,1e20,0.0],"nested":[{"x":1},{"x":2}],"1":"first","0":"zero"}';
    const output =
      '{"0":"zero","1":"first","values":[9007199254740992,1.23,100000000000000000000,0],"nested":[{"x":1},{"x":2}]}\n{"type":"message","message":{"role":"user","__openclaw":{"media":[{"path":"x"}]}}}\n';
    expect(() =>
      captureOfflineSessionArchive(encode(exact + "\n" + media), { compressed }).assertPrepared(
        encode(output),
      ),
    ).not.toThrow();
  },
);
