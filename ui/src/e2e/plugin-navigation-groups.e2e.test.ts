import path from "node:path";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin sidebar groups" });
function moduleSource(grouped: boolean) {
  return `export default { id: "ui-fixture", activate(host) {
    const group = ${grouped ? '{id:"workspace", label:"Example workspace"}' : "undefined"};
    for (const [order, id, label] of [[8,"dashboard","Overview"],[9,"planner","Planner"],[10,"topics","Manage Topics"],[11,"histories","Imported History"]]) {
      host.ui.registerPage({id, label, mount(container) { const h = document.createElement("h1"); h.textContent = label; container.append(h); }});
      host.ui.registerNavigation({id, label, page:{id}, group, order});
    }
    host.ui.registerReplacement({ id: "topics", label: "Topics", surface: "session-list", mount(container) {
      const section = document.createElement("section"); section.setAttribute("aria-label", "PARA topics");
      for (const label of ["Projects", "Areas", "Resources", "Archives"]) { const p = document.createElement("p"); p.textContent = label; section.append(p); }
      container.append(section);
    }});
    host.ui.selectReplacement("session-list", "topics");
  }};`;
}

suite.define(() => {
  it("keeps grouped routes separate from the conversation replacement and keyboard operable", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
          },
        });
        let grouped = false;
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: moduleSource(grouped),
          }),
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.getByRole("link", { name: "Overview", exact: true }).waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "sidebar-before.png") });
        grouped = true;
        await page.reload();
        const group = sidebar.locator(".sidebar-nav__plugin-group");
        await group.waitFor();
        await expect
          .poll(async () =>
            (await group.getByRole("link").allTextContents()).map((text) => text.trim()),
          )
          .toEqual(["Overview", "Planner", "Manage Topics", "Imported History"]);
        expect(await sidebar.getByRole("link", { name: "Overview", exact: true }).count()).toBe(1);
        expect(await group.getByRole("region", { name: "PARA topics" }).count()).toBe(0);
        await sidebar.getByRole("region", { name: "PARA topics" }).waitFor();
        const plannerLink = group.getByRole("link", { name: "Planner", exact: true });
        await plannerLink.click();
        await page.getByRole("heading", { name: "Planner", exact: true }).waitFor();
        await expect.poll(() => plannerLink.getAttribute("aria-current")).toBe("page");
        await page.screenshot({ path: path.join(suite.artifactDir, "sidebar-after.png") });
        const summary = group.locator("summary");
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => group.getAttribute("open")).toBeNull();
        expect(await group.getByRole("link", { name: "Planner", exact: true }).isVisible()).toBe(
          false,
        );
        expect(await sidebar.getByRole("region", { name: "PARA topics" }).isVisible()).toBe(true);
        await page.keyboard.press("Enter");
        await group.getByRole("link", { name: "Overview", exact: true }).click();
        await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
        await page.reload();
        await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
        await expect
          .poll(() =>
            group.getByRole("link", { name: "Overview", exact: true }).getAttribute("aria-current"),
          )
          .toBe("page");
        await page.setViewportSize({ width: 900, height: 900 });
        await page.locator(".topbar-nav-toggle").click();
        await group.getByRole("link", { name: "Planner", exact: true }).waitFor();
        await expect
          .poll(async () => {
            const bounds = await page.locator(".shell-nav").boundingBox();
            return bounds !== null && bounds.x >= 0;
          })
          .toBe(true);
        expect(await sidebar.getByRole("region", { name: "PARA topics" }).isVisible()).toBe(true);
        await page.screenshot({ path: path.join(suite.artifactDir, "sidebar-narrow.png") });
      },
    );
  });
});
