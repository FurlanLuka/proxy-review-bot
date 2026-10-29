import Foundation

public struct UpdateState: Codable, Equatable, Sendable {
    public var currentVersion: String
    public var latestVersion: String?
    public var isUpdateAvailable: Bool
    public var canInstall: Bool
    public var cannotInstallReason: String?
    public var phase: UpdatePhase
    public var lastCheckedAt: Double?
    public var error: String?
    public var lastUpdate: LastUpdate?

    public init(
        currentVersion: String,
        latestVersion: String? = nil,
        isUpdateAvailable: Bool = false,
        canInstall: Bool = true,
        cannotInstallReason: String? = nil,
        phase: UpdatePhase = .idle,
        lastCheckedAt: Double? = nil,
        error: String? = nil,
        lastUpdate: LastUpdate? = nil
    ) {
        self.currentVersion = currentVersion
        self.latestVersion = latestVersion
        self.isUpdateAvailable = isUpdateAvailable
        self.canInstall = canInstall
        self.cannotInstallReason = cannotInstallReason
        self.phase = phase
        self.lastCheckedAt = lastCheckedAt
        self.error = error
        self.lastUpdate = lastUpdate
    }
}

public struct LastUpdate: Codable, Equatable, Sendable {
    public var version: String
    public var didSucceed: Bool

    public init(version: String, didSucceed: Bool) {
        self.version = version
        self.didSucceed = didSucceed
    }
}

public enum UpdatePhase: String, Codable, Sendable {
    case idle
    case checking
    case waitingForReviews = "waiting_for_reviews"
    case downloading
    case installing
    case failed

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = UpdatePhase(rawValue: value) ?? .idle
    }

    public var isBusy: Bool {
        switch self {
        case .checking, .waitingForReviews, .downloading, .installing:
            return true
        case .idle, .failed:
            return false
        }
    }
}

public enum UpdateButton: Equatable, Sendable {
    case check
    case install

    public var title: String {
        switch self {
        case .check:
            return "Check for updates"
        case .install:
            return "Update now"
        }
    }
}

extension UpdateState {
    public static let updateLogPath = "~/Library/Logs/ProxyReviewBot/update.log"

    public var statusText: String {
        let latest = latestVersion ?? currentVersion

        switch phase {
        case .checking:
            return "Checking for updates…"
        case .waitingForReviews:
            return "Updating to \(latest) after the current review…"
        case .downloading:
            return "Downloading \(latest)…"
        case .installing:
            return "Installing \(latest). The app restarts on its own."
        case .failed:
            return error ?? "The update failed"
        case .idle:
            break
        }

        // Only while that same version is still the one on offer: a newer release replaces the warning.
        if let lastUpdate, !lastUpdate.didSucceed, isUpdateAvailable, latestVersion == lastUpdate.version {
            return "The update to \(lastUpdate.version) didn't finish. See \(Self.updateLogPath)"
        }

        if isUpdateAvailable, let latestVersion {
            return "Version \(latestVersion) is available"
        }

        return latestVersion == nil ? "Version \(currentVersion)" : "Version \(currentVersion) · Up to date"
    }

    public var button: UpdateButton {
        isUpdateAvailable && canInstall ? .install : .check
    }

    public var isButtonEnabled: Bool {
        !phase.isBusy
    }

    /// Announces a finished update once, after the app restarts on the new version.
    public var successNotice: Notice? {
        guard let lastUpdate, lastUpdate.didSucceed else {
            return nil
        }

        return Notice(
            identifier: "update-\(lastUpdate.version)",
            title: "Updated to \(lastUpdate.version)",
            body: "Proxy Review Bot installed the update and restarted."
        )
    }
}
