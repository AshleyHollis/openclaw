import Foundation
@preconcurrency import UserNotifications

/// The only destination accepted from a host-owned plugin notification. It carries
/// identifiers, never a URL or an action, so opening it cannot mutate plugin state.
struct PluginNotificationDestination: Equatable, Hashable {
    let sourceID: String
    let tag: String
    let pluginID: String
    let tabID: String
    let destinationID: String
    let recordID: String

    /// The push source is the gateway's host identity, not its display or route id.
    func isOwnedByGateway(deviceID: String?) -> Bool {
        GatewayStableIdentifier.matches(self.sourceID, deviceID)
    }
}

/// Host-owned operation identity for silent plugin-notification clears.
struct PluginNotificationClearOperation: Equatable, Hashable {
    let sourceID: String
    let tag: String
}

enum PluginNotificationBridge {
    static let notificationKind = "plugin.notification"
    static let clearedKind = "plugin.notification.cleared"

    static func shouldPresentNotification(userInfo: [AnyHashable: Any]) -> Bool {
        self.parseDestination(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: userInfo) != nil
    }

    static func parseDestination(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]) -> PluginNotificationDestination?
    {
        guard actionIdentifier == UNNotificationDefaultActionIdentifier,
              let openclaw = self.exactRecord(
                  userInfo["openclaw"],
                  keys: ["version", "kind", "nodeId", "sourceId", "tag", "target", "ts"]),
              self.version(openclaw["version"]) == 1,
              openclaw["kind"] as? String == self.notificationKind,
              self.identifier(openclaw["nodeId"]) != nil,
              let sourceID = self.identifier(openclaw["sourceId"]),
              let tag = self.identifier(openclaw["tag"]),
              openclaw["ts"] is NSNumber,
              let target = self.exactRecord(
                  openclaw["target"],
                  keys: ["kind", "pluginId", "tabId", "destinationId", "recordId"]),
              target["kind"] as? String == "plugin-detail",
              let pluginID = self.identifier(target["pluginId"]),
              let tabID = self.identifier(target["tabId"]),
              let destinationID = self.identifier(target["destinationId"]),
              let recordID = self.identifier(target["recordId"])
        else {
            return nil
        }

        return PluginNotificationDestination(
            sourceID: sourceID,
            tag: tag,
            pluginID: pluginID,
            tabID: tabID,
            destinationID: destinationID,
            recordID: recordID)
    }

    static func parseClearOperation(userInfo: [AnyHashable: Any]) -> PluginNotificationClearOperation? {
        guard let openclaw = self.exactRecord(
            userInfo["openclaw"],
            keys: ["version", "kind", "nodeId", "sourceId", "tag", "ts"]),
            self.version(openclaw["version"]) == 1,
            openclaw["kind"] as? String == self.clearedKind,
            self.identifier(openclaw["nodeId"]) != nil,
            let sourceID = self.identifier(openclaw["sourceId"]),
            let tag = self.identifier(openclaw["tag"]),
            openclaw["ts"] is NSNumber
        else {
            return nil
        }
        return PluginNotificationClearOperation(sourceID: sourceID, tag: tag)
    }

    @MainActor
    static func removeNotifications(
        for operation: PluginNotificationClearOperation,
        notificationCenter: NotificationCentering) async
    {
        guard self.identifier(operation.sourceID) != nil,
              self.identifier(operation.tag) != nil
        else { return }

        // APNs owns remote request identifiers. The host tag already includes sourceID,
        // while delivered payloads match both fields so a collision cannot cross gateways.
        await notificationCenter.removePendingNotificationRequests(withIdentifiers: [operation.tag])
        let delivered = await notificationCenter.deliveredNotifications()
        let matchingIdentifiers = delivered.compactMap { notification in
            let destination = self.parseDestination(
                actionIdentifier: UNNotificationDefaultActionIdentifier,
                userInfo: notification.userInfo)
            return destination?.tag == operation.tag && destination?.sourceID == operation.sourceID
                ? notification.identifier
                : nil
        }
        await notificationCenter.removeDeliveredNotifications(withIdentifiers: matchingIdentifiers)
    }

    private static func exactRecord(_ rawValue: Any?, keys: Set<String>) -> [String: Any]? {
        guard let record = rawValue as? [String: Any], Set(record.keys) == keys else { return nil }
        return record
    }

    private static func identifier(_ rawValue: Any?) -> String? {
        guard let value = rawValue as? String,
              !value.isEmpty,
              value.utf8.count <= 128,
              let first = value.utf8.first,
              isAlphaNumeric(first),
              value.utf8.allSatisfy({ isIdentifierByte($0) })
        else {
            return nil
        }
        return value
    }

    private static func version(_ rawValue: Any?) -> Int? {
        guard let value = rawValue as? NSNumber, value.intValue == 1 else { return nil }
        return value.intValue
    }

    private static func isAlphaNumeric(_ byte: UInt8) -> Bool {
        (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte)
    }

    private static func isIdentifierByte(_ byte: UInt8) -> Bool {
        self.isAlphaNumeric(byte) || byte == 0x2D || byte == 0x2E || byte == 0x5F || byte == 0x3A
    }
}
