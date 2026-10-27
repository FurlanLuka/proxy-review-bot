import AppKit
import OSLog
import ProxyReviewBotCore
import UserNotifications

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter?

    override init() {
        center = Bundle.main.bundleURL.pathExtension == "app" ? UNUserNotificationCenter.current() : nil
        super.init()
        center?.delegate = self
    }

    func requestAuthorization() {
        guard let center else {
            Logger.notifications.info("Not running from an app bundle, notifications are disabled")
            return
        }

        center.requestAuthorization(options: [.alert, .sound]) { isGranted, error in
            if let error {
                Logger.notifications.error("Authorization failed: \(error.localizedDescription, privacy: .public)")
            } else {
                Logger.notifications.info("Authorization granted: \(isGranted)")
            }
        }
    }

    func post(_ notices: [Notice]) {
        guard let center else {
            return
        }

        for notice in notices {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.sound = .default

            center.add(UNNotificationRequest(identifier: notice.identifier, content: content, trigger: nil)) { error in
                if let error {
                    Logger.notifications.error("Could not post \(notice.identifier, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let path = AppRoute.path(forNoticeIdentifier: response.notification.request.identifier)

        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: MainWindowController.showRequest,
                object: nil,
                userInfo: [MainWindowController.pathUserInfoKey: path]
            )
            completionHandler()
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}
