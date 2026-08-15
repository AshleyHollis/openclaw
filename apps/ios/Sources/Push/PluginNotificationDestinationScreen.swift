import OpenClawKit
import SwiftUI

/// A notification tap can only open this authenticated Control UI page. The typed
/// destination becomes query data; no callback, approval, or plugin mutation is run.
struct PluginNotificationDestinationScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let destination: PluginNotificationDestination

    var body: some View {
        let config = self.appModel.activeGatewayConnectConfig
        let storedOperatorToken = AuthenticatedControlUI.storedOperatorToken(config: config)
        ZStack {
            OpenClawProBackground()
            if let url = Self.destinationURL(config: config, destination: self.destination),
               let authScript = AuthenticatedControlUI.authUserScript(
                   config: config,
                   pageURL: url,
                   storedOperatorToken: storedOperatorToken)
            {
                AuthenticatedControlUIWebView(url: url, authScript: authScript)
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
