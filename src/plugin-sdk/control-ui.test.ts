import { expect, expectTypeOf, it } from "vitest";
import {
  defineControlUiPlugin,
  type ControlUiHost,
  type ControlUiHostV2,
  type ControlUiPlugin,
} from "./control-ui.js";

it("keeps legacy plugin definitions compatible and gives mounted views current HTTP authority", () => {
  const legacy: ControlUiPlugin = { id: "legacy", activate: (_host: ControlUiHost) => undefined };
  expect(defineControlUiPlugin(legacy)).toBe(legacy);
  expectTypeOf<ControlUiHost>().not.toHaveProperty("httpRequest");
  const current = defineControlUiPlugin({
    id: "current",
    activate(host) {
      expectTypeOf(host).toEqualTypeOf<ControlUiHostV2>();
      host.ui.registerPage({
        id: "notes",
        label: "Notes",
        mount(_container, context) {
          expectTypeOf(context.host.httpRequest).toEqualTypeOf<ControlUiHostV2["httpRequest"]>();
          return {
            update(next) {
              expectTypeOf(next.host).toEqualTypeOf<ControlUiHostV2>();
            },
          };
        },
      });
      host.ui.registerAction({
        id: "save",
        label: "Save",
        placement: "header",
        run(context) {
          expectTypeOf(context.host).toEqualTypeOf<ControlUiHostV2>();
        },
      });
    },
  });
  expect(current.id).toBe("current");
});
