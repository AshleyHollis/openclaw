import { describe, expect, it } from "vitest";
import {
  readBtrfsFilesystemIdentityWithIoctl,
  readDurableFilesystemIdentity,
} from "./filesystem-identity.js";

describe("durable filesystem identity", () => {
  it("decodes the Btrfs filesystem UUID and containing subvolume from the kernel ABI", () => {
    const requests: number[] = [];
    const ioctl = (descriptor: number, request: number, argument: Buffer) => {
      expect(descriptor).toBe(17);
      requests.push(request);
      if (request === 0x8400941f) {
        Buffer.from("00112233445566778899aabbccddeeff", "hex").copy(argument, 16);
        return 0;
      }
      expect(request).toBe(0xd0009412);
      expect(argument.readBigUInt64LE(8)).toBe(256n);
      argument.writeBigUInt64LE(9123n, 0);
      return 0;
    };

    expect(readBtrfsFilesystemIdentityWithIoctl(17, ioctl, () => 0)).toEqual({
      version: 1,
      filesystem: "btrfs",
      filesystemId: "00112233-4455-6677-8899-aabbccddeeff",
      subvolumeId: "9123",
    });
    expect(requests).toEqual([0x8400941f, 0xd0009412]);
  });

  it("rejects an unsupported filesystem at the first Btrfs ioctl", () => {
    expect(() =>
      readBtrfsFilesystemIdentityWithIoctl(8, () => -1, () => 25),
    ).toThrow(expect.objectContaining({ message: "BTRFS_IOC_FS_INFO failed", errno: 25 }));
  });

  it("rejects invalid descriptors through the public capability boundary", async () => {
    await expect(readDurableFilesystemIdentity(-1)).rejects.toMatchObject({
      code: "capability-unavailable",
    });
  });
});
