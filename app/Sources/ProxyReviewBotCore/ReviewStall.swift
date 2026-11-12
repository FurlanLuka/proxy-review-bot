import Foundation

/// A review whose Claude has printed nothing for a while: slow and stuck look alike until then.
public enum ReviewStall {
    /// Matches the service's `STALL_AFTER_MS`
    public static let thresholdMinutes = 10

    public static func text(for pullRequest: PullRequest, now: Date) -> String? {
        guard pullRequest.status == .reviewing, let lastActivityAt = pullRequest.progress?.lastActivityAt else {
            return nil
        }

        let idleMinutes = Int((now.timeIntervalSince1970 * 1000 - lastActivityAt) / 60_000)

        return idleMinutes >= thresholdMinutes ? "No activity from Claude for \(idleMinutes) min" : nil
    }
}
