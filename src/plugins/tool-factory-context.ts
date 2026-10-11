import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { assertMemoryAudienceSession } from "./memory-audience.js";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

/** Host-only identity binding; registration opt-in never creates this authority. */
export type PluginToolOwnerContinuation = {
  isCurrent: () => boolean;
  assertCurrent: () => void;
  senderId?: string;
  channel?: string;
  accountId?: string;
};

/** One binding supplies both the factory's final-effect guard and its retained callbacks. */
export function createPluginToolFactoryContext(params: {
  entry: PluginToolRegistration;
  registry: PluginRegistry;
  context: OpenClawPluginToolContext;
  assertInvocationCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  ownerContinuation?: PluginToolOwnerContinuation;
}): OpenClawPluginToolContext<2> {
  const { entry, registry, context } = params;
  if (context.memoryAudience) {
    assertMemoryAudienceSession(context.memoryAudience, context.sessionKey);
  }
  const record = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
  const authority = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  const continuation = entry.contextVersion === 2 ? params.ownerContinuation : undefined;
  // Identity comes only from the admitted host owner, never the supplied context.
  const baseContext = { ...context };
  Reflect.deleteProperty(baseContext, "authenticatedOperator");
  const operatorAuthority =
    entry.contextVersion === 2 && params.assertInvocationCurrent
      ? params.operatorAuthority
      : undefined;
  if (operatorAuthority) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
  }
  const authenticatedOperator = operatorAuthority
    ? Object.freeze({
        profileId: operatorAuthority.profileId,
        scopes: Object.freeze([...operatorAuthority.scopes]),
      })
    : undefined;
  // Audience currency guards memory effects: the memory slot owner's own tools. Other
  // plugins reach memory through the provider guard, so a stale audience never fails them.
  const assertMemoryAudienceCurrent =
    resolveMemoryCapabilityRegistration(registry.memoryCapabilities)?.pluginId === entry.pluginId
      ? context.assertMemoryAudienceCurrent
      : undefined;
  const assertInvocationCurrent = () => {
    if (!authority?.()) {
      throw new Error(`Plugin "${entry.pluginId}" tool runtime is no longer active.`);
    }
    if (entry.contextVersion === 2 && !params.assertInvocationCurrent && !continuation) {
      throw new Error(
        "Plugin tool invocation authority is unavailable outside an admitted run or request",
      );
    }
    params.assertInvocationCurrent?.();
    operatorAuthority?.assertCurrent();
    continuation?.assertCurrent();
    assertMemoryAudienceCurrent?.();
  };
  return {
    ...baseContext,
    ...(authenticatedOperator ? { authenticatedOperator } : {}),
    ...(continuation
      ? {
          requesterSenderId: continuation.senderId,
          messageChannel: continuation.channel,
          agentAccountId: continuation.accountId,
        }
      : {}),
    get senderIsOwner() {
      return continuation ? continuation.isCurrent() : context.senderIsOwner;
    },
    assertInvocationCurrent,
  };
}
