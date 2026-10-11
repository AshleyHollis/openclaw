import type {
  WorkboardAttachment,
  WorkboardBoardMetadata,
  WorkboardCard,
  WorkboardNotificationSubscription,
  WorkboardResultReviewRequest,
} from "@openclaw/workboard-contract";
import type { PreparedSessionTranscriptSourceAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";

/**
 * Guard the first accepted write (including CAS retries), then allow its settlement.
 * Independently authorized effects need separate scopes; settled scopes cannot be reused.
 */
export type WorkboardWriteAuthority = <T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
  sourceAdmission?: PreparedSessionTranscriptSourceAdmission,
) => Promise<T>;

export type PersistedWorkboardCard = {
  version: 1;
  card: WorkboardCard;
};

export type PersistedWorkboardBoard = {
  version: 1;
  board: WorkboardBoardMetadata;
};

export type PersistedWorkboardNotificationSubscription = {
  version: 1;
  subscription: WorkboardNotificationSubscription;
};

export type PersistedWorkboardAttachment = {
  version: 1;
  attachment: WorkboardAttachment;
  contentBase64: string;
};

export type WorkboardKeyedStore<T = PersistedWorkboardCard> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};

export type WorkboardSubscriptionStore = Omit<
  WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>,
  "entries"
> & {
  entries(options?: {
    boardId?: string;
    cardId?: string;
  }): Promise<Array<{ key: string; value: PersistedWorkboardNotificationSubscription }>>;
};

type WorkboardBoardCardAggregate = {
  boardId: string;
  status: WorkboardCard["status"];
  total: number;
  archived: number;
  updatedAt: number;
};

export type WorkboardCardStatsAggregate = {
  status: WorkboardCard["status"];
  agentId: string | undefined;
  total: number;
  archived: number;
  updatedAt: number;
  oldestReadyAt: number | undefined;
};

export type WorkboardOwnerClaimResult = "updated" | "conflict" | "owner_busy";

export type WorkboardCardReadScope =
  | { kind: "board"; boardId: string }
  | { kind: "session"; sessionKey: string }
  | {
      kind: "worker-context";
      cardId: string;
      boardId: string;
      agentId?: string;
      parentIds: readonly string[];
    };

export type WorkboardCardStore = Omit<WorkboardKeyedStore, "entries"> & {
  registerWithResultReview(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    request: WorkboardResultReviewRequest,
  ): Promise<false | { card: WorkboardCard; inserted: boolean }>;
  getResultReview(id: string): Promise<WorkboardResultReviewRequest | undefined>;
  listResultReviews(scope: {
    tenant: string;
    boardId: string;
    cardId: string;
  }): Promise<WorkboardResultReviewRequest[]>;
  resolveResultReview(
    id: string,
    expectedRevision: number,
    expectedUpdatedAt: number,
    decision: "reviewed" | "withdrawn",
    now: number,
  ): Promise<{ request: WorkboardResultReviewRequest; card: WorkboardCard } | undefined>;
  entries(
    scope?: WorkboardCardReadScope,
  ): Promise<Array<{ key: string; value: PersistedWorkboardCard }>>;
  registerIfAbsent(key: string, value: PersistedWorkboardCard): Promise<boolean>;
  registerIdempotent(
    key: string,
    value: PersistedWorkboardCard,
    intent: string,
    parentIds: readonly string[],
    missingParentId?: string,
  ): Promise<{ card: WorkboardCard; inserted: boolean }>;
  registerIfUpdatedAt(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
  ): Promise<boolean>;
  deleteIfUpdatedAt(key: string, expectedUpdatedAt: number): Promise<boolean>;
  claimIfOwnerAvailable(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    ownerId: string,
    now: number,
  ): Promise<WorkboardOwnerClaimResult>;
  listCardStatuses(ids: readonly string[]): Promise<Array<{ id: string; status: string }>>;
  listBoardAggregates(): Promise<WorkboardBoardCardAggregate[]>;
  listStatsAggregates(boardId?: string): Promise<WorkboardCardStatsAggregate[]>;
  hasCards(boardId: string): Promise<boolean>;
};
