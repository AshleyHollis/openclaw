import Foundation
import Testing
import UserNotifications
@testable import OpenClaw

private final class PluginNotificationMockCenter: NotificationCentering, @unchecked Sendable {
    var pendingRemovedIdentifiers: [[String]] = []
    var deliveredRemovedIdentifiers: [[String]] = []
    var delivered: [NotificationSnapshot] = []

    func authorizationStatus() async -> NotificationAuthorizationStatus { .authorized }
    func add(_: UNNotificationRequest) async throws {}

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async {
        self.pendingRemovedIdentifiers.append(identifiers)
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async {
        self.deliveredRemovedIdentifiers.append(identifiers)
        self.delivered.removeAll { identifiers.contains($0.identifier) }
    }

    func deliveredNotifications() async -> [NotificationSnapshot] {
        self.delivered
    }
}

struct PluginNotificationBridgeTests {
    private static let destinationUserInfo: [AnyHashable: Any] = [
        "openclaw": [
            "version": 1,
            "kind": PluginNotificationBridge.notificationKind,
            "nodeId": "ios-node",
            "tag": "operation-tag",
            "target": [
                "kind": "plugin-detail",
                "pluginId": "board",
                "tabId": "items",
                "destinationId": "item",
                "recordId": "record-1",
            ],
            "ts": 1,
        ],
    ]

    @Test func `default taps accept only bounded plugin destinations`() throws {
        let destination = try #require(PluginNotificationBridge.parseDestination(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: Self.destinationUserInfo))
        #expect(destination == PluginNotificationDestination(
            tag: "operation-tag",
            pluginID: "board",
            tabID: "items",
            destinationID: "item",
            recordID: "record-1"))
        #expect(PluginNotificationBridge.parseDestination(
            actionIdentifier: "approve",
            userInfo: Self.destinationUserInfo) == nil)

        var wrongVersion = Self.destinationUserInfo
        var wrongVersionPayload = try #require(wrongVersion["openclaw"] as? [String: Any])
        wrongVersionPayload["version"] = 2
        wrongVersion["openclaw"] = wrongVersionPayload
        #expect(PluginNotificationBridge.parseDestination(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: wrongVersion) == nil)

        var untrusted = Self.destinationUserInfo
        untrusted["openclaw"] = [
            "version": 1,
            "kind": PluginNotificationBridge.notificationKind,
            "nodeId": "ios-node",
            "tag": "operation-tag",
            "target": [
                "kind": "plugin-detail",
                "pluginId": "board",
                "tabId": "items",
                "destinationId": "item",
                "recordId": "record-1",
                "url": "https://example.invalid/approve",
            ],
            "ts": 1,
        ]
        #expect(PluginNotificationBridge.parseDestination(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: untrusted) == nil)
    }

    @Test @MainActor func `silent clears remove matching delivered notifications idempotently`() async {
        let center = PluginNotificationMockCenter()
        center.delivered = [
            NotificationSnapshot(identifier: "matching", userInfo: Self.destinationUserInfo),
            NotificationSnapshot(
                identifier: "other",
                userInfo: [
                    "openclaw": [
                        "version": 1,
                        "kind": PluginNotificationBridge.notificationKind,
                        "nodeId": "ios-node",
                        "tag": "other-operation",
                        "target": [
                            "kind": "plugin-detail",
                            "pluginId": "board",
                            "tabId": "items",
                            "destinationId": "item",
                            "recordId": "record-2",
                        ],
                        "ts": 1,
                    ],
                ]),
        ]

        let clearTag = try #require(PluginNotificationBridge.parseClearTag(userInfo: [
            "openclaw": [
                "version": 1,
                "kind": PluginNotificationBridge.clearedKind,
                "nodeId": "ios-node",
                "tag": "operation-tag",
                "ts": 2,
            ],
        ]))
        await PluginNotificationBridge.removeNotifications(forTag: clearTag, notificationCenter: center)
        await PluginNotificationBridge.removeNotifications(forTag: clearTag, notificationCenter: center)

        #expect(center.pendingRemovedIdentifiers == [["operation-tag"], ["operation-tag"]])
        #expect(center.deliveredRemovedIdentifiers == [["matching"], []])
    }

    @Test func `clear payloads reject arbitrary data`() {
        #expect(PluginNotificationBridge.parseClearTag(userInfo: [
            "openclaw": [
                "version": 1,
                "kind": PluginNotificationBridge.clearedKind,
                "nodeId": "ios-node",
                "tag": "operation-tag",
                "ts": 2,
                "url": "https://example.invalid/clear",
            ],
        ]) == nil)
    }
}
