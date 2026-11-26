/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { render } from "../test-helpers/chat-transcript-native.tsx";
import { threadFixture } from "./chat-transcript-fixture.test-support.tsx";
import { installTranscriptDomMocks, requireElement, resetTranscriptTestDom, threadProps } from "./chat-transcript.test-support.ts";

const cleanups: (() => void)[] = [];
beforeEach(installTranscriptDomMocks);
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  resetTranscriptTestDom();
});

it("routes ordinary local plugin citations with their exact search and fragment", async () => {
  const onNavigate = vi.fn();
  const props = { ...threadProps("pane-plugin-citation"), basePath: "/ui", onNavigate };
  const { container, rerender, transcript } = threadFixture(props);
  cleanups.push(() => {
    render(null, container);
    transcript.dispose();
  });
  rerender();
  transcript.start();
  await waitForSolid(() => expect(container.querySelector(".chat-thread")).not.toBeNull());
  const link = requireElement(container, ".chat-thread").appendChild(document.createElement("a"));
  const search =
    "?plugin=command-center&id=topic&p.sourcePath=shared.md&p.evidenceSourceVersion=v1";
  const citation = `/ui/plugin${search}#note`;

  function click(href: string, init: MouseEventInit = {}): boolean {
    link.href = href;
    let intercepted = false;
    window.addEventListener(
      "click",
      (event) => {
        intercepted = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    return intercepted;
  }

  expect(click(citation)).toBe(true);
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("plugin", { search, hash: "#note" });

  for (const href of [
    `https://other.invalid${citation}`,
    `/plugin${search}`,
    "/ui/plugin?plugin=command-center",
    `/ui/plugin${search}&__openclawPluginPath=%2Fother`,
  ]) {
    expect(click(href)).toBe(false);
  }
  expect(click(citation, { ctrlKey: true })).toBe(false);
  expect(click(citation, { button: 1 })).toBe(false);
  link.target = "_blank";
  expect(click(citation)).toBe(false);
  link.target = "_self";
  link.download = "note.md";
  expect(click(citation)).toBe(false);
  expect(onNavigate).toHaveBeenCalledTimes(1);
});
