import path from "node:path";
import { createServer } from "vite";
import { controlUiHoverGuardPlugin } from "../../config/control-ui-hover-guard.ts";
import { controlUiLocaleModulesPlugin } from "../../config/control-ui-locales.ts";
import { controlUiWebAwesomePageRulePlugin } from "../../config/control-ui-web-awesome-page-rule.ts";
import {
  commonJsOptimizeDeps,
  controlUiBrowserOnlySharedModuleAliases,
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../../vite.config.ts";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { resolveAvailableLoopbackPort } from "./control-ui-e2e-port.ts";

// Loaded only by the Node-owned private source server. Bundled E2E paths
// already inherit the canonical build configuration.
export async function startControlUiE2eSourceServer(
  repoRoot: string,
  resolvedBuildInfo: ControlUiBuildInfo,
  json5EsmPath: string,
) {
  const uiRoot = path.join(repoRoot, "ui");
  const port = await resolveAvailableLoopbackPort();
  const server = await createServer({
    base: "/",
    cacheDir: path.join(repoRoot, ".artifacts", "control-ui-e2e-vite"),
    clearScreen: false,
    configFile: false,
    css: {
      postcss: {
        plugins: [controlUiHoverGuardPlugin(), controlUiWebAwesomePageRulePlugin()],
      },
    },
    define: {
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(resolvedBuildInfo),
    },
    logLevel: "error",
    optimizeDeps: {
      include: ["ipaddr.js", "lit/directives/repeat.js", ...commonJsOptimizeDeps],
    },
    publicDir: path.join(uiRoot, "public"),
    plugins: [controlUiLocaleModulesPlugin(), controlUiBrowserOnlySharedModuleAliases()],
    resolve: {
      alias: [
        { find: "json5", replacement: json5EsmPath },
        ...resolveExternalPackageAliasesForVite(),
        ...resolveSourcePackageAliasesForVite(),
        ...resolveTsconfigPathAliasesForVite(),
      ],
    },
    root: uiRoot,
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  });
  await server.listen(port);
  return server;
}
