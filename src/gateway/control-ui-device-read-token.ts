import { verifyDeviceToken } from "../infra/device-pairing-tokens.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import type { PluginNotificationPrincipalBinding } from "../plugins/notification-emitter-host.js";

const CONTROL_UI_OPERATOR_READ_SCOPE = "operator.read";
const CONTROL_UI_OPERATOR_ROLE = "operator";

export async function verifyControlUiDeviceReadToken(
  token: string,
  requiredSharedGatewaySessionGeneration: string | undefined,
): Promise<{
  scopes: string[];
  notificationBinding?: PluginNotificationPrincipalBinding;
} | null> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorToken = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (
      !operatorToken ||
      operatorToken.revokedAtMs ||
      !verifyPairingToken(token, operatorToken.token)
    ) {
      continue;
    }
    const verified = await verifyDeviceToken({
      deviceId: device.deviceId,
      token,
      role: CONTROL_UI_OPERATOR_ROLE,
      scopes: [CONTROL_UI_OPERATOR_READ_SCOPE],
      requiredSharedGatewaySessionGeneration,
    });
    if (!verified.ok) {
      return null;
    }
    const scopes = [...operatorToken.scopes];
    const { capturePluginNotificationPrincipalBindingFromControlUiDevice } =
      await import("../plugins/notification-emitter-host.js");
    return {
      scopes,
      notificationBinding: capturePluginNotificationPrincipalBindingFromControlUiDevice({
        operatorId: "gateway:default-operator",
        deviceId: device.deviceId,
        scopes,
        verifiedDevice: device,
        ...(requiredSharedGatewaySessionGeneration
          ? { sharedGatewaySessionGeneration: requiredSharedGatewaySessionGeneration }
          : {}),
      }),
    };
  }
  return null;
}
