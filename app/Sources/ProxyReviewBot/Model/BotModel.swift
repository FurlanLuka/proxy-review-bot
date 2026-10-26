import AppKit
import OSLog
import ProxyReviewBotCore

@MainActor
final class BotModel: ObservableObject {
    private static let pollIntervalSeconds: Double = 3

    @Published private(set) var state: BotState?
    @Published private(set) var connection: ServiceConnection = .starting
    @Published private(set) var busyPullRequestIDs: Set<Int> = []
    @Published var actionMessage: String?

    private let token = UUID().uuidString
    private let notifier = Notifier()
    private lazy var serviceProcess = ServiceProcess(token: token)
    private var client: ServiceClient?
    private var pollingTask: Task<Void, Never>?
    private var notificationPlanner = NotificationPlanner()

    var attentionCount: Int {
        state.map { PullRequestSections.attentionCount(of: $0.pullRequests) } ?? 0
    }

    func start() {
        notifier.requestAuthorization()
        serviceProcess.onListening = { [weak self] port in
            self?.connect(port: port)
        }
        serviceProcess.onExit = { [weak self] message in
            self?.disconnect(message: message)
        }
        serviceProcess.start()
    }

    func shutDown() {
        pollingTask?.cancel()
        serviceProcess.stop()
    }

    func review(_ pullRequest: PullRequest) {
        perform(.review(pullRequestID: pullRequest.id), on: pullRequest)
    }

    func approve(_ pullRequest: PullRequest) {
        perform(.approve(pullRequestID: pullRequest.id), on: pullRequest)
    }

    func stop(_ pullRequest: PullRequest) {
        perform(.stop(pullRequestID: pullRequest.id), on: pullRequest)
    }

    func retry(_ pullRequest: PullRequest) {
        perform(.retry(pullRequestID: pullRequest.id), on: pullRequest)
    }

    func togglePause() {
        guard let state else {
            return
        }

        perform(state.isPaused ? .resume : .pause, on: nil)
    }

    func checkReadiness() {
        perform(.checkReadiness, on: nil)
    }

    func saveSettings(_ settings: BotSettings) async throws {
        guard let client else {
            throw ServiceClientError.invalidResponse
        }

        let savedSettings = try await client.saveSettings(settings)
        state?.settings = savedSettings
        await refresh()
    }

    func openLogs() {
        let logsDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/ProxyReviewBot")
        try? FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logsDirectory)
    }

    private func connect(port: Int) {
        client = ServiceClient(port: port, token: token)
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(Self.pollIntervalSeconds))
            }
        }
    }

    private func disconnect(message: String) {
        client = nil
        pollingTask?.cancel()
        pollingTask = nil
        connection = .unavailable(message: message)
    }

    private func refresh() async {
        guard let client else {
            return
        }

        do {
            let newState = try await client.fetchState()
            state = newState
            connection = .connected
            notifier.post(notificationPlanner.notices(for: newState.pullRequests, readiness: newState.readiness))
        } catch {
            connection = .unavailable(message: "Can't reach the service")
        }
    }

    private func perform(_ action: ServiceAction, on pullRequest: PullRequest?) {
        guard let client else {
            actionMessage = "The service isn't running"
            return
        }

        if let pullRequest {
            busyPullRequestIDs.insert(pullRequest.id)
        }

        Task {
            defer {
                if let pullRequest {
                    busyPullRequestIDs.remove(pullRequest.id)
                }
            }

            do {
                try await client.perform(action)
                actionMessage = nil
            } catch {
                actionMessage = Self.message(for: error, pullRequest: pullRequest)
            }

            await refresh()
        }
    }

    private static func message(for error: Error, pullRequest: PullRequest?) -> String {
        let name = pullRequest?.shortName ?? "That"

        switch error as? ServiceClientError {
        case .failed(_, "head_moved"):
            return "\(name) has new commits, review queued again"
        case .failed(_, "not_awaiting_approval"):
            return "\(name) is no longer awaiting approval"
        case .failed(404, _):
            return "\(name) is no longer tracked"
        default:
            return error.localizedDescription
        }
    }
}
