import type { WorkboardCard } from "@openclaw/workboard-contract";
import { cardParentIds } from "./store-card-helpers.js";

/** Native lifecycle holds shared by the async owner and synchronous SQLite commit. */
export function assertWorkboardStatusHolds(
  existing: WorkboardCard,
  next: WorkboardCard,
  now: number,
  parentStatuses: ReadonlyArray<{ id: string; status: WorkboardCard["status"] }>,
): void {
  if (!["ready", "running", "review", "done"].includes(next.status)) return;
  const parents = cardParentIds(next);
  const cards = new Map(parentStatuses.map((card) => [card.id, card]));
  if (!parents.every((parentId) => cards.get(parentId)?.status === "done"))
    throw new Error("card dependencies are not done.");
  if (next.status === "done") return;
  const scheduledAt = next.metadata?.automation?.scheduledAt;
  if ((scheduledAt && scheduledAt > now) || (existing.status === "scheduled" && !scheduledAt))
    throw new Error("card is scheduled for later.");
}
