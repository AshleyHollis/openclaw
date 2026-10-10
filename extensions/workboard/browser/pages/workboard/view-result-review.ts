import type { WorkboardResultReviewRequest } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { t } from "../../i18n/index.ts";
import { workboardCardBoardId } from "../../lib/workboard/board-filter.ts";
import { replaceCard } from "../../lib/workboard/card-state.ts";
import { normalizeCardPayload } from "../../lib/workboard/normalization.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { renderDetailList, renderProofDetails } from "./view-card-detail-records.ts";
import { canMutate, type WorkboardProps } from "./view-helpers.ts";

class ResultReviewDirective extends AsyncDirective {
  private props?: WorkboardProps;
  private card?: WorkboardCard;
  private scope = "";
  private generation = 0;
  private requests: WorkboardResultReviewRequest[] = [];
  private loading = false;
  private resolving = false;
  private error = "";

  render(props: WorkboardProps, card: WorkboardCard) {
    const scope = JSON.stringify([
      card.id,
      workboardCardBoardId(card),
      card.metadata?.automation?.tenant,
      card.updatedAt,
      props.connected,
      props.connectionGeneration,
      props.scopeAgentId,
      props.presented !== false,
      props.canWrite,
    ]);
    if (
      scope !== this.scope ||
      props.client !== this.props?.client ||
      props.host !== this.props?.host
    ) {
      this.scope = scope;
      this.generation += 1;
      this.requests = [];
      this.error = "";
      this.props = props;
      this.card = card;
      if (props.client && props.connected && props.presented !== false) {
        void this.load(this.generation);
      }
    }
    this.props = props;
    this.card = card;
    return this.view();
  }

  private current(generation: number): boolean {
    const props = this.props;
    const card = this.card;
    if (
      !this.isConnected ||
      generation !== this.generation ||
      !props ||
      !card ||
      !props.client ||
      !props.connected ||
      props.presented === false
    ) {
      return false;
    }
    const state = getWorkboardState(props.host);
    const current = state.cards.find((entry) => entry.id === card.id);
    return (
      state.detailCardId === card.id &&
      !state.draftOpen &&
      current?.updatedAt === card.updatedAt &&
      workboardCardBoardId(current) === workboardCardBoardId(card) &&
      current.metadata?.automation?.tenant === card.metadata?.automation?.tenant
    );
  }

  private matches(request: WorkboardResultReviewRequest): boolean {
    const card = this.card;
    return Boolean(
      card &&
      request &&
      request.schemaVersion === 1 &&
      request.cardId === card.id &&
      request.boardId === workboardCardBoardId(card) &&
      request.tenant === (card.metadata?.automation?.tenant ?? "") &&
      request.id &&
      request.sessionKey &&
      request.runId &&
      ["pending", "reviewed", "withdrawn"].includes(request.status) &&
      request.result &&
      typeof request.result.summary === "string" &&
      Array.isArray(request.result.proof) &&
      request.result.proof.every(
        (proof) =>
          proof &&
          typeof proof.id === "string" &&
          ["passed", "failed", "skipped", "unknown"].includes(proof.status),
      ) &&
      Array.isArray(request.result.artifacts) &&
      request.result.artifacts.every((artifact) => artifact && typeof artifact.id === "string") &&
      /^[a-f0-9]{64}$/.test(request.requestRevision) &&
      /^[a-f0-9]{64}$/.test(request.resultDigest) &&
      Number.isSafeInteger(request.revision) &&
      request.revision >= 1,
    );
  }

  private params() {
    const card = this.card!;
    return {
      cardId: card.id,
      boardId: workboardCardBoardId(card),
      tenant: card.metadata?.automation?.tenant ?? "",
    };
  }

  private async load(generation: number) {
    this.loading = true;
    try {
      const payload = await this.props!.client!.request<{
        requests: WorkboardResultReviewRequest[];
      }>("workboard.resultReviews.list", this.params());
      if (!this.current(generation)) {
        return;
      }
      if (
        !Array.isArray(payload.requests) ||
        payload.requests.some((request) => !this.matches(request))
      ) {
        throw new Error(t("workboard.resultReviewUnavailable"));
      }
      this.requests = payload.requests;
    } catch {
      if (this.current(generation)) {
        this.error = t("workboard.resultReviewUnavailable");
      }
    } finally {
      if (this.current(generation)) {
        this.loading = false;
        this.setValue(this.view());
      }
    }
  }

  private async resolve(request: WorkboardResultReviewRequest, decision: "reviewed" | "withdrawn") {
    const generation = this.generation;
    const props = this.props!;
    const card = this.card!;
    const state = getWorkboardState(props.host);
    if (
      !this.current(generation) ||
      this.resolving ||
      !canMutate(props) ||
      state.busyCardIds.has(card.id) ||
      state.dispatching ||
      card.metadata?.archivedAt ||
      request.status !== "pending" ||
      !this.matches(request)
    ) {
      return;
    }
    this.resolving = true;
    state.busyCardIds.add(card.id);
    this.error = "";
    this.setValue(this.view());
    props.onRequestUpdate?.();
    try {
      const payload = await props.client!.request<{
        request: WorkboardResultReviewRequest;
        card: WorkboardCard;
      }>("workboard.resultReviews.resolve", {
        ...this.params(),
        requestId: request.id,
        expectedRevision: request.revision,
        expectedUpdatedAt: card.updatedAt,
        decision,
      });
      if (!this.current(generation) || !canMutate(this.props!)) {
        return;
      }
      const resolved = payload.request;
      const resolvedCard = normalizeCardPayload(payload);
      if (
        !this.matches(resolved) ||
        resolved.id !== request.id ||
        resolved.requestRevision !== request.requestRevision ||
        resolved.resultDigest !== request.resultDigest ||
        resolved.status !== decision ||
        resolved.revision <= request.revision ||
        resolvedCard.id !== card.id ||
        workboardCardBoardId(resolvedCard) !== workboardCardBoardId(card) ||
        resolvedCard.metadata?.automation?.tenant !== card.metadata?.automation?.tenant ||
        (decision === "reviewed" &&
          ((resolvedCard.execution?.sessionKey ?? resolvedCard.sessionKey) !== request.sessionKey ||
            (resolvedCard.execution?.runId ?? resolvedCard.runId) !== request.runId)) ||
        resolvedCard.updatedAt <= card.updatedAt
      ) {
        throw new Error(t("workboard.resultReviewUnavailable"));
      }
      this.requests = this.requests.map((entry) => (entry.id === resolved.id ? resolved : entry));
      replaceCard(state, resolvedCard);
    } catch {
      if (this.current(generation)) {
        this.requests = [];
        this.error = t("workboard.resultReviewResolveFailed");
      }
    } finally {
      state.busyCardIds.delete(card.id);
      this.resolving = false;
      if (this.current(generation)) {
        this.setValue(this.view());
      }
      props.onRequestUpdate?.();
    }
  }

  private view() {
    if (!this.props || !this.card || this.props.presented === false || !this.props.connected) {
      return nothing;
    }
    const props = this.props;
    const card = this.card;
    const state = getWorkboardState(props.host);
    const disabled =
      this.resolving ||
      !canMutate(props) ||
      state.busyCardIds.has(card.id) ||
      state.dispatching ||
      Boolean(card.metadata?.archivedAt);
    if (this.loading || (!this.requests.length && !this.error)) {
      return nothing;
    }
    return html`<section
      class="workboard-detail__result-review"
      aria-label=${t("workboard.resultReviewTitle")}
    >
      <h3>${t("workboard.resultReviewTitle")}</h3>
      ${
        this.error
          ? html`<p role="status">${this.error}</p>
              <button
                class="btn"
                type="button"
                @click=${() => {
                  this.error = "";
                  void this.load(this.generation);
                }}
              >
                ${t("common.retry")}
              </button>`
          : nothing
      }
      ${this.requests.map(
        (request) => html`<article data-result-review-id=${request.id}>
          <p>${request.result.summary}</p>
          ${renderProofDetails(request.result.proof)}
          ${renderDetailList(
            t("workboard.badgeArtifacts", { count: String(request.result.artifacts.length) }),
            request.result.artifacts.map((artifact) =>
              [artifact.label, artifact.url, artifact.path, artifact.mimeType]
                .filter(Boolean)
                .join(" - "),
            ),
          )}
          <p>
            ${
              request.status === "pending"
                ? t("workboard.resultReviewPending")
                : request.status === "reviewed"
                  ? t("workboard.resultReviewReviewed")
                  : t("workboard.resultReviewWithdrawn")
            }
          </p>
          ${
            request.status === "pending"
              ? html`<div class="workboard-detail__actions">
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${disabled || card.status !== "review" || (card.execution?.sessionKey ?? card.sessionKey) !== request.sessionKey || (card.execution?.runId ?? card.runId) !== request.runId}
                    @click=${() => void this.resolve(request, "reviewed")}
                  >
                    ${t("workboard.resultReviewMarkReviewed")}
                  </button>
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${disabled}
                    @click=${() => void this.resolve(request, "withdrawn")}
                  >
                    ${t("workboard.resultReviewWithdraw")}
                  </button>
                </div>`
              : nothing
          }
        </article>`,
      )}
    </section>`;
  }

  protected override disconnected() {
    this.generation += 1;
    this.scope = "";
    this.requests = [];
  }

  protected override reconnected() {
    if (this.props && this.card) {
      this.setValue(this.render(this.props, this.card));
    }
  }
}

export const renderResultReview = directive(ResultReviewDirective);
