import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareChannelRunAdmission } from "../auto-reply/reply/channel-run-admission.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { prepareGatewayLocalUserIngress } from "../gateway/local-user-ingress.js";
import { invalidateOperatorRolePolicy } from "../gateway/operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginToolContext } from "../plugins/tool-types.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPreparedEmbeddedGatewayTools } from "./embedded-agent-runner/run/attempt-gateway-tools.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("admitted operator plugin tool projection", () => {
  it.each([
    "allowed",
    "write-allowed",
    "scope-widened",
    "scope-narrowed",
    "profile-replaced",
    "role-revoked",
    "run-closed",
    "plugin-retired",
    "unprofiled",
  ] as const)(
    "preserves the actual operator capture and preparation boundary when %s",
    async (mode) =>
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        const config = {
          plugins: { allow: ["probe"], entries: { probe: { enabled: true } } },
          gateway: {
            roles: {
              definitions: {
                reader: {
                  agents: [],
                  scopes: ["operator.read" as const, "operator.write" as const],
                  sessions: { others: "none" as const },
                },
                denied: { agents: [], scopes: [], sessions: { others: "none" as const } },
              },
            },
          },
        };
        const gateway = createContext();
        gateway.getRuntimeConfig = () => config;
        const client = createOperatorClient({
          profileName: "plugin-projection",
          scopes:
            mode === "scope-narrowed" || mode === "write-allowed"
              ? ["operator.read", "operator.write"]
              : ["operator.read"],
        });
        const profileId = client.authenticatedUserProfile!.profileId;
        setUserProfileRole(profileId, "reader");
        if (mode === "unprofiled") {
          client.authenticatedUserProfile = undefined;
        }
        // This is the production source capture, not a constructed admitted authority.
        const originalCapture = await captureGatewayOperatorRunAuthority({
          client,
          context: gateway,
          sourceAuthority: null,
        });
        if (mode === "scope-narrowed") {
          client.internal = {
            ...client.internal,
            operatorRunAuthority: originalCapture!.authority,
          };
          client.connect.scopes = ["operator.read"];
        }
        const captured =
          mode === "scope-narrowed"
            ? await captureGatewayOperatorRunAuthority({
                client,
                context: gateway,
                sourceAuthority: null,
              })
            : originalCapture;
        if (mode === "scope-widened") {
          client.connect.scopes?.push("operator.admin");
        }
        const prepared = prepareChannelRunAdmission({
          cfg: config,
          runId: `operator-projection-${mode}`,
          agentId: "main",
          ingressKind: "gateway-client",
          boundary: "gateway.chat.send",
          gatewayLocalUserIngress: prepareGatewayLocalUserIngress({
            authenticatedUserExpected: mode !== "unprofiled",
            profile: client.authenticatedUserProfile,
            isLocalClient: true,
          }),
          operatorAuthority: captured?.authority,
        });
        const builder = createTestPluginRegistry(createPluginRuntimeMock());
        const manifestRegistry = makeRegistry([
          { id: "probe", channels: [], contracts: { tools: ["probe", "legacy_probe"] } },
        ]);
        const record = createPluginRecord({
          id: "probe",
          origin: "config",
          source: "/fake/probe/index.js",
          rootDir: "/fake/probe",
          contracts: { tools: ["probe", "legacy_probe"] },
        });
        bindPluginRuntimeArtifactSelection(record, {
          preferBuiltPluginArtifacts: false,
          runtimeEntry: resolvePluginRuntimeArtifactSelection({
            source: record.source,
            rootDir: "/fake/probe",
            origin: "config",
            preferBuiltPluginArtifacts: false,
            entryKind: "runtime",
          }),
        });
        builder.registry.plugins.push(record);
        const metadataSnapshot = createPluginMetadataSnapshot({ config, manifestRegistry });
        metadataSnapshot.index.plugins = createPluginMetadataSnapshotFixture({
          plugins: manifestRegistry.plugins,
        }).index.plugins;
        setPluginRuntimeLoadContext(builder.registry, {
          rawConfig: config,
          config,
          activationSourceConfig: config,
          autoEnabledReasons: {},
          workspaceDir: undefined,
          env: process.env,
          metadataSnapshot,
          manifestRegistry,
          logger: { info() {}, warn() {}, error() {} },
        });
        const entered = createDeferred();
        const resume = createDeferred();
        let observed: OpenClawPluginToolContext<2> | undefined;
        let legacy: OpenClawPluginToolContext | undefined;
        let effects = 0;
        const api = builder.createApi(record, { config, registrationMode: "full" });
        api.registerTool(
          {
            contextVersion: 2,
            create(context) {
              observed = context;
              return {
                name: "probe",
                label: "Probe",
                description: "Original operator scope projection",
                parameters: { type: "object", properties: {} },
                async execute() {
                  entered.resolve();
                  await resume.promise;
                  context.assertInvocationCurrent();
                  effects++;
                  return { content: [], details: context.authenticatedOperator ?? {} };
                },
              };
            },
          },
          { name: "probe" },
        );
        api.registerTool(
          (context) => {
            legacy = context;
            return {
              name: "legacy_probe",
              label: "Legacy",
              description: "V1 projection absence",
              parameters: { type: "object", properties: {} },
              async execute() {
                return { content: [], details: {} };
              },
            };
          },
          { name: "legacy_probe" },
        );
        let tool: AnyAgentTool | undefined;
        try {
          const admittedRunContext = await prepared.admit("embedded");
          await withPreparedEmbeddedGatewayTools(
            {
              admittedRunContext,
              agentId: "main",
              sessionKey: "agent:main:projection",
              sessionId: "projection-session",
              agentHarnessId: "embedded",
              messageChannel: "webchat",
            },
            () => true,
            async () =>
              withPluginRuntimeRegistryScope(builder.registry, async () => {
                tool = resolveOpenClawPluginToolsForOptions({
                  options: {
                    config,
                    agentSessionKey: "agent:main:projection",
                    sessionId: "projection-session",
                    senderIsOwner: true,
                  },
                  resolvedConfig: config,
                }).find((candidate) => candidate.name === "probe");
                expect(tool).toBeDefined();
                expect(legacy).not.toHaveProperty("authenticatedOperator");
                const expectedScopes =
                  mode === "write-allowed"
                    ? ["operator.read", "operator.write"]
                    : ["operator.read"];
                if (mode === "unprofiled") {
                  expect(observed).not.toHaveProperty("authenticatedOperator");
                } else {
                  expect(observed?.authenticatedOperator).toEqual({
                    profileId,
                    scopes: expectedScopes,
                  });
                  expect(Object.isFrozen(observed?.authenticatedOperator)).toBe(true);
                  expect(Object.isFrozen(observed?.authenticatedOperator?.scopes)).toBe(true);
                  if (mode !== "write-allowed") {
                    expect(observed?.authenticatedOperator?.scopes).not.toContain("operator.write");
                  }
                }
                const pending = tool!.execute("projection", {});
                void pending.catch(() => {});
                await entered.promise;
                if (mode === "profile-replaced") {
                  const replacement = ensureProfileForEmail("replacement-projection@example.test");
                  linkEmail("plugin-projection@example.test", replacement.id);
                }
                if (mode === "role-revoked") {
                  await setCanonicalUserProfileRole(profileId, "denied", {
                    onCommitted: invalidateOperatorRolePolicy,
                  });
                }
                if (mode === "run-closed") {
                  prepared.close();
                }
                if (mode === "plugin-retired") {
                  markPluginRegistryRetired(builder.registry);
                }
                resume.resolve();
                if (
                  mode === "allowed" ||
                  mode === "write-allowed" ||
                  mode === "scope-widened" ||
                  mode === "scope-narrowed" ||
                  mode === "unprofiled"
                ) {
                  await expect(pending).resolves.toMatchObject({
                    details: mode === "unprofiled" ? {} : { profileId, scopes: expectedScopes },
                  });
                  expect(effects).toBe(1);
                } else {
                  await expect(pending).rejects.toThrow();
                  expect(effects).toBe(0);
                }
              }),
          );
          prepared.close();
          await expect(tool!.execute("retained", {})).rejects.toThrow();
        } finally {
          resume.resolve();
          prepared.close();
          captured?.release();
          if (captured !== originalCapture) {
            originalCapture?.release();
          }
          markPluginRegistryRetired(builder.registry);
        }
      }),
  );
});
