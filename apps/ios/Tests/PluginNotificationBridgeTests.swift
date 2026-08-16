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
    private static var destinationUserInfo: [AnyHashable: Any] {
        [
            "openclaw": [
                "version": 1,
                "kind": PluginNotificationBridge.notificationKind,
                "nodeId": "ios-node",
                "sourceId": "gateway-a",
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
    }

    @Test func `default taps accept only bounded plugin destinations`() throws {
        let destination = try #require(PluginNotificationBridge.parseDestination(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: Self.destinationUserInfo))
        #expect(destination == PluginNotificationDestination(
            sourceID: "gateway-a",
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
            "sourceId": "gateway-a",
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

    @Test func `two gateway notification taps require their emitting source`() throws {
        let destination = try #require(PluginNotificationBridge.parseDestination(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: Self.destinationUserInfo))

        #expect(destination.isOwnedByGateway(deviceID: "gateway-a"))
        #expect(!destination.isOwnedByGateway(deviceID: "gateway-b"))
        #expect(!destination.isOwnedByGateway(deviceID: nil))
    }

    @Test @MainActor func `silent clears remove matching delivered notifications idempotently`() async throws {
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
                        "sourceId": "gateway-a",
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

        let clearOperation = try #require(PluginNotificationBridge.parseClearOperation(userInfo: [
            "openclaw": [
                "version": 1,
                "kind": PluginNotificationBridge.clearedKind,
                "nodeId": "ios-node",
                "sourceId": "gateway-a",
                "tag": "operation-tag",
                "ts": 2,
            ],
        ]))
        await PluginNotificationBridge.removeNotifications(for: clearOperation, notificationCenter: center)
        await PluginNotificationBridge.removeNotifications(for: clearOperation, notificationCenter: center)

        #expect(center.pendingRemovedIdentifiers == [["operation-tag"], ["operation-tag"]])
        #expect(center.deliveredRemovedIdentifiers == [["matching"], []])
    }

    @Test @MainActor func `silent clears do not cross gateway sources`() async throws {
        let center = PluginNotificationMockCenter()
        var otherGateway = Self.destinationUserInfo
        otherGateway["openclaw"] = [
            "version": 1,
            "kind": PluginNotificationBridge.notificationKind,
            "nodeId": "ios-node",
            "sourceId": "gateway-b",
            "tag": "operation-tag",
            "target": [
                "kind": "plugin-detail",
                "pluginId": "board",
                "tabId": "items",
                "destinationId": "item",
                "recordId": "record-1",
            ],
            "ts": 1,
        ]
        center.delivered = [
            NotificationSnapshot(identifier: "gateway-a", userInfo: Self.destinationUserInfo),
            NotificationSnapshot(identifier: "gateway-b", userInfo: otherGateway),
        ]
        let operation = try #require(PluginNotificationBridge.parseClearOperation(userInfo: [
            "openclaw": [
                "version": 1,
                "kind": PluginNotificationBridge.clearedKind,
                "nodeId": "ios-node",
                "sourceId": "gateway-a",
                "tag": "operation-tag",
                "ts": 2,
            ],
        ]))

        await PluginNotificationBridge.removeNotifications(for: operation, notificationCenter: center)

        #expect(center.deliveredRemovedIdentifiers == [["gateway-a"]])
        #expect(center.delivered.map(\.identifier) == ["gateway-b"])
    }

    @Test func `clear payloads reject arbitrary data`() {
        #expect(PluginNotificationBridge.parseClearOperation(userInfo: [
            "openclaw": [
                "version": 1,
                "kind": PluginNotificationBridge.clearedKind,
                "nodeId": "ios-node",
                "sourceId": "gateway-a",
                "tag": "operation-tag",
                "ts": 2,
                "url": "https://example.invalid/clear",
            ],
        ]) == nil)
    }
}
