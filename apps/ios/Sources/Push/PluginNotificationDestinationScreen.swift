import OpenClawKit
import SwiftUI

/// A notification tap can only open this authenticated Control UI page. The typed
/// destination becomes query data; no callback, approval, or plugin mutation is run.
struct PluginNotificationDestinationScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var verifiedGatewayConfig: GatewayConnectConfig?
    let destination: PluginNotificationDestination

    var body: some View {
        let activeConfig = self.appModel.activeGatewayConnectConfig
        let config: GatewayConnectConfig? = if let verifiedGatewayConfig,
                                               let activeConfig,
                                               verifiedGatewayConfig.hasSameConnectionInputs(as: activeConfig)
        {
            verifiedGatewayConfig
        } else {
            nil
        }
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: config)
        ZStack {
            OpenClawProBackground()
            if let url = Self.destinationURL(config: config, destination: self.destination),
               let authScript = AuthenticatedControlUI.authUserScript(
                   config: config,
                   pageURL: url,
                   storedOperatorToken: storedOperatorToken)
            {
                AuthenticatedControlUIWebView(
                    url: url,
                    authScript: authScript,
                    tls: config?.tls)
                    .id(AuthenticatedControlUI.webContentIdentity(
                        config: config,
                        storedOperatorToken: storedOperatorToken))
                    .ignoresSafeArea(.container, edges: .bottom)
            } else {
                self.unavailableCard
            }
        }
        .navigationTitle("Notification")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    self.dismiss()
                } label: {
                    Text("Done")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
        }
        .task(id: self.gatewayValidationID) {
            self.verifiedGatewayConfig = nil
            let config = await self.appModel.verifiedPluginNotificationGatewayConfig(
                for: self.destination)
            guard !Task.isCancelled else { return }
            self.verifiedGatewayConfig = config
        }
    }

    private var gatewayValidationID: String {
        let activeConfig = self.appModel.activeGatewayConnectConfig
        let authIdentity = AuthenticatedControlUI.webContentIdentity(
            config: activeConfig,
            storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: activeConfig))
        return [
            self.destination.sourceID,
            self.appModel.isOperatorGatewayConnected ? "connected" : "offline",
            String(authIdentity),
        ].joined(separator: "\u{0}")
    }

    private var unavailableCard: some View {
        VStack(spacing: 12) {
            ProIconBadge(systemName: "bell.badge", color: OpenClawBrand.accent)
            Text("Notification needs gateway authentication")
                .font(OpenClawType.subheadSemiBold)
            Text("Reconnect to your gateway to view this plugin destination.")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
    }

    static func destinationURL(
        config: GatewayConnectConfig?,
        destination: PluginNotificationDestination) -> URL?
    {
        AuthenticatedControlUI.pageURL(
            config: config,
            path: "/plugin",
            queryItems: [
                URLQueryItem(name: "plugin", value: destination.pluginID),
                URLQueryItem(name: "id", value: destination.tabID),
                URLQueryItem(name: "notification", value: "plugin-detail"),
                URLQueryItem(name: "destination", value: destination.destinationID),
                URLQueryItem(name: "record", value: destination.recordID),
            ])
    }
}
