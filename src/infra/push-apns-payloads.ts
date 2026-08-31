// Builds portable APNs payloads for alerts, wakes, and approval lifecycle events.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChannelApprovalKind } from "./approval-types.js";

const EXEC_APPROVAL_GENERIC_ALERT_BODY = "Open OpenClaw to review this request.";
const PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH = 256;

export type PluginNotificationApnsTarget = {
  kind: "plugin-detail";
  pluginId: string;
  tabId: string;
  destinationId: string;
  recordId: string;
};

function toPushMetadata(params: {
  kind: "push.test" | "node.wake";
  nodeId: string;
  reason?: string;
}): { kind: "push.test" | "node.wake"; nodeId: string; ts: number; reason?: string } {
  return {
    kind: params.kind,
    nodeId: params.nodeId,
    ts: Date.now(),
    ...(params.reason ? { reason: params.reason } : {}),
  };
}

export function createApnsAlertPayload(params: {
  nodeId: string;
  title: string;
  body: string;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
    },
    openclaw: toPushMetadata({
      kind: "push.test",
      nodeId: params.nodeId,
    }),
  };
}

export function createApnsBackgroundPayload(params: {
  nodeId: string;
  wakeReason?: string;
}): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: toPushMetadata({
      kind: "node.wake",
      reason: params.wakeReason ?? "node.invoke",
      nodeId: params.nodeId,
    }),
  };
}

export function resolveExecApprovalAlertBody(): string {
  return EXEC_APPROVAL_GENERIC_ALERT_BODY;
}

export function createApnsApprovalAlertPayload(params: {
  kind: ChannelApprovalKind;
  approvalId: string;
  gatewayDeviceId: string;
  title: string;
  body: string;
  category: string;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
      category: params.category,
      "content-available": 1,
    },
    openclaw: {
      kind: `${params.kind}.approval.requested`,
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      ts: Date.now(),
    },
  };
}

export function resolvePluginApprovalAlertBody(description: string): string {
  const body = normalizeOptionalString(description) ?? "";
  if (body.length <= PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH) {
    return body;
  }
  return `${truncateUtf16Safe(body, PLUGIN_APPROVAL_ALERT_BODY_MAX_LENGTH - 1).trimEnd()}…`;
}

export function createApnsApprovalResolvedPayload(params: {
  kind: ChannelApprovalKind;
  approvalId: string;
  gatewayDeviceId: string;
}): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: {
      kind: `${params.kind}.approval.resolved`,
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      ts: Date.now(),
    },
  };
}

/** Create the host-owned typed navigation payload for a plugin notification alert. */
export function createApnsPluginNotificationAlertPayload(params: {
  nodeId: string;
  title: string;
  body: string;
  sourceId: string;
  tag: string;
  target: PluginNotificationApnsTarget;
}): object {
  return {
    aps: {
      alert: {
        title: params.title,
        body: params.body,
      },
      sound: "default",
      "thread-id": params.tag,
    },
    openclaw: {
      version: 1,
      kind: "plugin.notification",
      nodeId: params.nodeId,
      sourceId: params.sourceId,
      tag: params.tag,
      target: params.target,
      ts: Date.now(),
    },
  };
}

/** Create the idempotent silent clear payload for a plugin notification operation. */
export function createApnsPluginNotificationClearedPayload(params: {
  nodeId: string;
  sourceId: string;
  tag: string;
}): object {
  return {
    aps: {
      "content-available": 1,
    },
    openclaw: {
      version: 1,
      kind: "plugin.notification.cleared",
      nodeId: params.nodeId,
      sourceId: params.sourceId,
      tag: params.tag,
      ts: Date.now(),
    },
  };
}
