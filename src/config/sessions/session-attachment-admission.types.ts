/** Exact accepted user-entry media identity. No filesystem path or host authority is serialized. */
export type AcceptedSessionAttachmentSelection = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
  entryId: string;
  generation: string;
  mediaIndex: number;
  mediaRef: string;
}>;

/** A bounded original copy may be staged before publication; that copy is not admission. */
export type AcceptedSessionAttachmentAdmission = Readonly<{
  /** Lowercase SHA-256 of the original bytes, in sha256:<hex> format. */
  originalDigest: string;
  sizeBytes: number;
  getOriginalBytes(): Buffer;
  /** The host effect is synchronous; its enclosing native admission settles asynchronously. */
  publish(effect: () => void): Promise<void>;
  /** Revoke retained callers immediately, then join native custody before releasing it. */
  close(): Promise<void>;
}>;

export type AcceptedSessionAttachmentEffectState = "not-entered" | "entered" | "completed";

/** Publication errors preserve whether the exact effect may require existing owner recovery. */
export class AcceptedSessionAttachmentPublicationError extends Error {
  readonly code = "accepted_attachment_publication_failed";

  constructor(
    message: string,
    readonly effectState: AcceptedSessionAttachmentEffectState,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "AcceptedSessionAttachmentPublicationError";
  }
}
