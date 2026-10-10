import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDurableFilesystemIdentity } from "./filesystem-identity.js";

const native = vi.hoisted(() => {
  const ioctl = vi.fn<(descriptor: number, request: number, argument: Buffer) => number>();
  const func = vi.fn<(signature: string) => typeof ioctl>(() => ioctl);
  const load = vi.fn<(library: null) => { func: typeof func }>(() => ({ func }));
  const errno = vi.fn<() => number>(() => 0);
  return { ioctl, func, load, errno };
});

vi.mock("koffi", () => ({ default: { load: native.load, errno: native.errno } }));

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  native.ioctl.mockReset();
  native.errno.mockReset().mockReturnValue(0);
  native.load.mockClear();
  native.func.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("durable filesystem identity", () => {
  it("decodes the Btrfs filesystem UUID and containing subvolume from the kernel ABI", async () => {
    const requests: number[] = [];
    native.ioctl.mockImplementation((descriptor, request, argument) => {
      expect(descriptor).toBe(17);
      requests.push(request);
      if (request === 0x8400941f) {
        expect(argument.length).toBe(1024);
        Buffer.from("00112233445566778899aabbccddeeff", "hex").copy(argument, 16);
        return 0;
      }
      expect(request).toBe(0xd0009412);
      expect(argument.length).toBe(4096);
      expect(argument.readBigUInt64LE(8)).toBe(256n);
      argument.writeBigUInt64LE(9123n, 0);
      return 0;
    });

    await expect(readDurableFilesystemIdentity(17)).resolves.toEqual({
      version: 1,
      filesystem: "btrfs",
      filesystemId: "00112233-4455-6677-8899-aabbccddeeff",
      subvolumeId: "9123",
    });
    expect(requests).toEqual([0x8400941f, 0xd0009412]);
    expect(native.load).toHaveBeenCalledExactlyOnceWith(null);
    expect(native.func).toHaveBeenCalledExactlyOnceWith(
      "int ioctl(int fd, unsigned long request, void *argument)",
    );
  });

  it("rejects an unsupported filesystem at the first Btrfs ioctl", async () => {
    native.ioctl.mockReturnValue(-1);
    native.errno.mockReturnValue(25);
    await expect(readDurableFilesystemIdentity(8)).rejects.toMatchObject({
      code: "capability-unavailable",
      cause: { message: "BTRFS_IOC_FS_INFO failed", errno: 25 },
    });
    expect(native.ioctl).toHaveBeenCalledTimes(1);
  });

  it("rejects failure of the containing-subvolume lookup", async () => {
    native.ioctl.mockImplementation((_fd, request, argument) => {
      if (request === 0x8400941f) {
        Buffer.from("00112233445566778899aabbccddeeff", "hex").copy(argument, 16);
        return 0;
      }
      return -1;
    });
    native.errno.mockReturnValue(5);
    await expect(readDurableFilesystemIdentity(8)).rejects.toMatchObject({
      code: "capability-unavailable",
      cause: { message: "BTRFS_IOC_INO_LOOKUP failed", errno: 5 },
    });
    expect(native.ioctl).toHaveBeenCalledTimes(2);
  });

  it("rejects a zero containing-subvolume identity", async () => {
    native.ioctl.mockReturnValue(0);
    await expect(readDurableFilesystemIdentity(8)).rejects.toMatchObject({
      code: "capability-unavailable",
      cause: { message: "Btrfs returned an invalid durable filesystem identity" },
    });
  });

  it("rejects invalid descriptors through the public capability boundary", async () => {
    await expect(readDurableFilesystemIdentity(-1)).rejects.toMatchObject({
      code: "capability-unavailable",
    });
    expect(native.load).not.toHaveBeenCalled();
  });
});
