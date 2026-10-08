import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { ControlUiAgentPickerProps } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { mountPage } from "./workboard-page.test-support.ts";
import { workboardPageTarget } from "./workboard-page.ts";

const exactCard = () =>
  createWorkboardCard({
    id: "exact-card",
    title: "Exact destination",
    metadata: { automation: { boardId: "ops", tenant: "life" } },
  });
const target = { cardId: "exact-card", tenant: "life" };

function visibleError(page: ReturnType<typeof mountPage>) {
  return page.container.querySelector("openclaw-workboard-toast:not([hidden])")?.shadowRoot
    ?.textContent;
}

async function connectedPage() {
  const page = mountPage();
  page.cards([exactCard()]);
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
  return page;
}

describe("authenticated exact card navigation", () => {
  it("declares the native plugin, exact board, card and optional tenant", () => {
    expect(workboardPageTarget("ops", target)).toEqual({
      pluginId: "workboard",
      id: "workboard",
      path: ["ops"],
      params: target,
    });
    expect(workboardPageTarget("default", { cardId: "local" }).params).toEqual({
      cardId: "local",
      tenant: null,
    });
    for (const boardId of ["other", "__all__"]) {
      expect(workboardPageTarget(boardId)).toEqual({
        pluginId: "workboard",
        id: "workboard",
        path: boardId === "__all__" ? [] : [boardId],
        params: { cardId: null, tenant: null },
      });
    }
  });

  it.each(["cold", "warm"])(
    "opens the exact details through a current authenticated read on %s navigation",
    async (mode) => {
      const page =
        mode === "warm" ? await connectedPage() : mountPage({ boardId: "ops", ...target });
      if (mode === "cold") {
        page.cards([exactCard()]);
        page.fixture.connection.connected = true;
        page.fixture.notify();
      } else {
        page.request.mockClear();
        page.navigate("ops", target);
      }
      await vi.waitFor(() => expect(page.workboard.state.detailCardId).toBe(target.cardId));
      expect(page.container.querySelector(".workboard-detail-drawer")).not.toBeNull();
      expect(page.request).toHaveBeenCalledWith("workboard.cards.list", {});
      expect(page.request.mock.calls.map(([method]) => method)).not.toEqual(
        expect.arrayContaining([
          "workboard.cards.start",
          "workboard.cards.create",
          "workboard.cards.update",
          "workboard.cards.diagnostics.refresh",
        ]),
      );
      expect(page.fixture.host.navigation.openPage).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "board", "tenant", "absent-tenant", "archived"])(
    "shows an unavailable destination for %s without board fallback",
    async (mismatch) => {
      const page = await connectedPage();
      const card = exactCard();
      if (mismatch === "board") {
        card.metadata = { automation: { boardId: "other", tenant: "life" } };
      }
      if (mismatch === "tenant") {
        card.metadata = { automation: { boardId: "ops", tenant: "other" } };
      }
      if (mismatch === "absent-tenant") {
        card.metadata = { automation: { boardId: "ops" } };
      }
      if (mismatch === "archived") {
        card.metadata = { ...card.metadata, archivedAt: 10 };
      }
      page.cards(mismatch === "missing" ? [] : [card]);
      page.workboard.setBoardsReady(true);
      page.navigate("ops", target);
      await vi.waitFor(() =>
        expect(visibleError(page)).toContain("This Workboard card is unavailable"),
      );
      expect(page.workboard.state.detailCardId).toBeNull();
      expect(page.workboard.state.boardFilter).toBe("ops");
      expect(page.fixture.host.navigation.openPage).not.toHaveBeenCalled();
    },
  );

  it("retains unsaved new-card text and defers the exact destination", async () => {
    const page = await connectedPage();
    Object.assign(page.workboard.state, { draftOpen: true, draftTitle: "Keep my text" });
    page.navigate("ops", target);
    await vi.waitFor(() => expect(visibleError(page)).toContain("Finish the current edit"));
    expect(page.workboard.state.draftTitle).toBe("Keep my text");
    expect(page.workboard.state.boardFilter).toBe("__all__");
    expect(page.workboard.state.detailCardId).toBeNull();
    page.workboard.state.draftOpen = false;
    page.workboard.notify();
    await vi.waitFor(() => expect(page.workboard.state.detailCardId).toBe(target.cardId));
  });

  it("retains submitted editor input while its save is pending", async () => {
    const page = await connectedPage();
    Object.assign(page.workboard.state, {
      draftOpen: true,
      editingCardId: "exact-card",
      draftSaving: true,
      draftTitle: "Submitted input",
    });
    page.request.mockClear();
    page.navigate("other", { cardId: "second", tenant: "life" });
    await vi.waitFor(() => expect(visibleError(page)).toContain("Finish the current edit"));
    expect(page.workboard.state.draftSaving).toBe(true);
    expect(page.workboard.state.editingCardId).toBe("exact-card");
    expect(page.workboard.state.draftTitle).toBe("Submitted input");
    expect(page.request).not.toHaveBeenCalledWith("workboard.cards.list", {});
  });

  it("preserves the actual inline editor and focused input when another destination is requested", async () => {
    const page = await connectedPage();
    page.navigate("ops", target);
    await vi.waitFor(() => expect(page.workboard.state.detailCardId).toBe(target.cardId));
    const trigger = expectDefined(
      page.container.querySelector<HTMLButtonElement>(".workboard-detail__text-trigger"),
      "inline title trigger",
    );
    trigger.click();
    await vi.waitFor(() =>
      expect(page.container.querySelector("workboard-inline-text input")).not.toBeNull(),
    );
    const input = expectDefined(
      page.container.querySelector<HTMLInputElement>("workboard-inline-text input"),
      "inline title input",
    );
    input.value = "Keep inline text";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    page.navigate("other", { cardId: "second", tenant: "life" });
    await vi.waitFor(() => expect(visibleError(page)).toContain("Finish the current edit"));
    expect(page.container.querySelector("workboard-inline-text input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Keep inline text");
    expect(page.workboard.state.detailCardId).toBe(target.cardId);
    expect(page.workboard.state.boardFilter).toBe("ops");
  });

  it("keeps the open destination's inline draft when agent scope changes", async () => {
    const page = await connectedPage();
    page.navigate("ops", target);
    await vi.waitFor(() => expect(page.workboard.state.detailCardId).toBe(target.cardId));
    expectDefined(
      page.container.querySelector<HTMLButtonElement>(".workboard-detail__text-trigger"),
      "title edit",
    ).click();
    await vi.waitFor(() =>
      expect(page.container.querySelector("workboard-inline-text input")).not.toBeNull(),
    );
    const input = expectDefined(
      page.container.querySelector<HTMLInputElement>("workboard-inline-text input"),
      "title input",
    );
    input.value = "Keep while scope changes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    page.fixture.host.agents.setScope("writer");
    await vi.waitFor(() =>
      expect(
        page.container.querySelector<HTMLElement & ControlUiAgentPickerProps>(
          "[data-test-agent-picker]",
        )?.value,
      ).toBe("writer"),
    );
    expect(page.workboard.state.detailCardId).toBe(target.cardId);
    expect(page.container.querySelector("workboard-inline-text input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Keep while scope changes");
  });

  it("uses the existing archived-card visibility policy", async () => {
    const page = await connectedPage();
    page.cards([{ ...exactCard(), metadata: { ...exactCard().metadata, archivedAt: 10 } }]);
    page.workboard.state.showArchived = true;
    page.navigate("ops", target);
    await vi.waitFor(() => expect(page.workboard.state.detailCardId).toBe(target.cardId));
    expect(page.container.querySelector(".workboard-detail-drawer")).not.toBeNull();
  });

  it("records a rejected authenticated read without opening cached details", async () => {
    const page = await connectedPage();
    const original = expectDefined(
      page.request.getMockImplementation(),
      "authenticated host handler",
    );
    page.request.mockImplementation(async (method, params) => {
      if (method === "workboard.cards.list") {
        throw new Error("Card read unavailable");
      }
      return original(method, params);
    });
    page.navigate("ops", target);
    await vi.waitFor(() => expect(visibleError(page)).toContain("Card read unavailable"));
    expect(page.workboard.state.detailCardId).toBeNull();
    expect(page.container.querySelector(".workboard-detail-drawer")).toBeNull();
  });

  it("does not publish a held card read after the page is disposed", async () => {
    const page = await connectedPage();
    const held = createDeferred<unknown>();
    const original = expectDefined(
      page.request.getMockImplementation(),
      "authenticated host handler",
    );
    page.request.mockImplementation(async (method, params) =>
      method === "workboard.cards.list" ? held.promise : original(method, params),
    );
    page.navigate("ops", target);
    await vi.waitFor(() => expect(page.workboard.state.loading).toBe(true));
    page.dispose();
    held.resolve({ cards: [exactCard()] });
    await held.promise;
    expect(page.container.textContent).toBe("");
    expect(page.workboard.state.detailCardId).toBeNull();
    expect(page.workboard.state.loaded).toBe(false);
  });

  it("does not let an earlier target replace a later card selection", async () => {
    const page = await connectedPage();
    const held = createDeferred<unknown>();
    const original = expectDefined(
      page.request.getMockImplementation(),
      "authenticated host handler",
    );
    page.request.mockImplementation(async (method, params) =>
      method === "workboard.cards.list" ? held.promise : original(method, params),
    );
    page.navigate("ops", target);
    await vi.waitFor(() => expect(page.workboard.state.loading).toBe(true));
    const second = { ...exactCard(), id: "second", title: "Second destination" };
    page.navigate("ops", { cardId: second.id, tenant: "life" });
    page.request.mockImplementation(async (method, params) =>
      method === "workboard.cards.list"
        ? { cards: [exactCard(), second] }
        : original(method, params),
    );
    held.resolve({ cards: [exactCard()] });
    await vi.waitFor(() => expect(page.workboard.state.detailCardId).toBe(second.id));
    expect(page.container.querySelector(".workboard-detail")?.textContent).toContain(second.title);
  });

  it("rejects a disconnected generation even when its old read settles after reconnect", async () => {
    const page = await connectedPage();
    const held = createDeferred<unknown>();
    const original = expectDefined(
      page.request.getMockImplementation(),
      "authenticated host handler",
    );
    page.request.mockImplementation(async (method, params) =>
      method === "workboard.cards.list" ? held.promise : original(method, params),
    );
    page.navigate("ops", target);
    await vi.waitFor(() => expect(page.workboard.state.loading).toBe(true));
    page.fixture.connection.connected = false;
    page.fixture.notify();
    await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(false));
    page.request.mockImplementation(async (method, params) =>
      method === "workboard.cards.list" ? { cards: [] } : original(method, params),
    );
    page.fixture.connection.connected = true;
    page.fixture.notify();
    await vi.waitFor(() => expect(visibleError(page)).toContain("unavailable"));
    held.resolve({ cards: [exactCard()] });
    await vi.waitFor(() => expect(page.workboard.state.loading).toBe(false));
    expect(page.workboard.state.detailCardId).toBeNull();
    expect(page.workboard.state.cards).toEqual([]);
  });
});
