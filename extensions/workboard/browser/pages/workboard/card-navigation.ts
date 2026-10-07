import { t } from "../../i18n/index.ts";
import { workboardCardBoardId } from "../../lib/workboard/board-filter.ts";
import type { WorkboardCard, WorkboardUiState } from "../../lib/workboard/types.ts";
import { openCardDetails } from "./view-card-details.ts";

export type WorkboardCardTarget = { cardId: string; tenant?: string };

// A target is verified against the existing authenticated, generation-scoped
// card loader. Cached cards alone never establish a new navigation admission.
export function createWorkboardCardNavigation(state: WorkboardUiState, requestUpdate: () => void) {
  let intent = "";
  let pending = false;
  let verified = false;
  let opened = false;
  let error: string | undefined;
  let revision = 0;
  return {
    update(params: {
      props: Readonly<Record<string, string>>;
      boardId: string;
      connectionGeneration: number;
      active: boolean;
      deferred: boolean;
      visible: (card: WorkboardCard) => boolean;
      load: () => Promise<boolean>;
    }) {
      const exact = Object.hasOwn(params.props, "cardId");
      const next = exact
        ? JSON.stringify([
            params.boardId,
            params.props.cardId,
            params.props.tenant,
            params.connectionGeneration,
            params.active,
          ])
        : "";
      if (next !== intent) {
        intent = next;
        revision += 1;
        pending = verified = opened = false;
        error = undefined;
      }
      if (!exact) {
        return { exact, deferred: false, error };
      }
      if (params.deferred) {
        return {
          exact,
          deferred: true,
          error: opened ? error : t("workboard.cardDestinationDeferred"),
        };
      }
      if (!opened) {
        state.detailCardId = null;
      }
      if (params.active && !pending && !verified && !error) {
        pending = true;
        const admittedRevision = revision;
        void params
          .load()
          .catch(() => false)
          .then((loaded) => {
            if (revision !== admittedRevision) {
              return;
            }
            pending = false;
            verified = loaded;
            if (!loaded) {
              error = t("workboard.cardDestinationUnavailable");
            }
            requestUpdate();
          });
      }
      if (verified && params.active) {
        const card = state.cards.find((entry) => entry.id === params.props.cardId);
        if (
          !card ||
          workboardCardBoardId(card) !== params.boardId ||
          !params.visible(card) ||
          card.metadata?.automation?.tenant !== params.props.tenant ||
          (card.metadata?.archivedAt && !state.showArchived)
        ) {
          state.detailCardId = null;
          error = t("workboard.cardDestinationUnavailable");
        } else {
          error = undefined;
          if (!opened) {
            openCardDetails(state, card);
            opened = true;
          }
        }
      }
      return { exact, deferred: false, error };
    },
    invalidate() {
      revision += 1;
      intent = "";
    },
  };
}
