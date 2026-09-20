const BTRFS_IOC_INO_LOOKUP = 0xd0009412;
const BTRFS_IOC_FS_INFO = 0x8400941f;
const BTRFS_FIRST_FREE_OBJECTID = 256n;

export type DurableFilesystemIdentity = Readonly<{
  version: 1;
  filesystem: "btrfs";
  filesystemId: string;
  subvolumeId: string;
}>;

function uuidFromBytes(value: Buffer): string {
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function capabilityError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code: "capability-unavailable" });
}

type Ioctl = (descriptor: number, request: number, argument: Buffer) => number;

// Kept below the public SDK seam so the ABI layout can be tested without
// requiring a privileged or Btrfs-backed CI runner.
export function readBtrfsFilesystemIdentityWithIoctl(
  descriptor: number,
  ioctl: Ioctl,
  errno: () => number,
): DurableFilesystemIdentity {
  const filesystem = Buffer.alloc(1024);
  if (ioctl(descriptor, BTRFS_IOC_FS_INFO, filesystem) !== 0) {
    throw Object.assign(new Error("BTRFS_IOC_FS_INFO failed"), { errno: errno() });
  }

  const subvolume = Buffer.alloc(4096);
  subvolume.writeBigUInt64LE(BTRFS_FIRST_FREE_OBJECTID, 8);
  if (ioctl(descriptor, BTRFS_IOC_INO_LOOKUP, subvolume) !== 0) {
    throw Object.assign(new Error("BTRFS_IOC_INO_LOOKUP failed"), { errno: errno() });
  }

  const filesystemId = uuidFromBytes(filesystem.subarray(16, 32));
  const subvolumeId = subvolume.readBigUInt64LE(0).toString(10);
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(filesystemId) ||
    subvolumeId === "0"
  ) {
    throw new Error("Btrfs returned an invalid durable filesystem identity");
  }
  return Object.freeze({ version: 1, filesystem: "btrfs", filesystemId, subvolumeId });
}

/**
 * Read the durable filesystem and containing-subvolume identity for a held
 * Btrfs descriptor. The ioctl special case is unprivileged and follows the
 * descriptor, including when the object lives below a nested subvolume.
 */
export async function readDurableFilesystemIdentity(
  descriptor: number,
): Promise<DurableFilesystemIdentity> {
  if (process.platform !== "linux" || !Number.isInteger(descriptor) || descriptor < 0) {
    throw capabilityError("Durable Btrfs filesystem identity is unavailable.");
  }

  try {
    const { default: koffi } = await import("koffi");
    const ioctl = koffi.load(null).func("int ioctl(int fd, unsigned long request, void *argument)");

    return readBtrfsFilesystemIdentityWithIoctl(descriptor, ioctl, () => koffi.errno());
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "capability-unavailable"
    ) {
      throw error;
    }
    throw capabilityError("Durable Btrfs filesystem identity is unavailable.", error);
  }
}
