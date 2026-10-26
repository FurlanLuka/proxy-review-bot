import OSLog

extension Logger {
    private static let subsystem = "com.furlanluka.proxy-review-bot"

    static let app = Logger(subsystem: subsystem, category: "app")
    static let service = Logger(subsystem: subsystem, category: "service")
    static let client = Logger(subsystem: subsystem, category: "client")
    static let notifications = Logger(subsystem: subsystem, category: "notifications")
}
