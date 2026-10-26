import Foundation
import OSLog
import ProxyReviewBotCore

@MainActor
final class ServiceProcess {
    private static let maximumRestartDelaySeconds: Double = 30
    private static let stableRunSeconds: Double = 60

    var onListening: ((Int) -> Void)?
    var onExit: ((String) -> Void)?

    private let token: String
    private var configuration: ServiceLaunchConfiguration?
    private var process: Process?
    private var standardInputPipe: Pipe?
    private var lineReaders: [PipeLineReader] = []
    private var launchedAt = Date()
    private var restartDelaySeconds: Double = 1
    private var isStopping = false
    private var exitWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]

    init(token: String) {
        self.token = token
    }

    func start() {
        Task {
            configuration = await Task.detached { ServiceLaunchConfiguration.resolve() }.value

            guard configuration != nil else {
                Logger.service.error("Service directory not found")
                onExit?("Service files not found")
                return
            }

            launch()
        }
    }

    func stop() {
        isStopping = true

        guard let process, process.isRunning else {
            return
        }

        Logger.service.info("Stopping service (pid \(process.processIdentifier))")
        process.terminate()
    }

    func stopAndWaitForExit(timeoutSeconds: Double) async -> Bool {
        stop()

        guard let process, process.isRunning else {
            return true
        }

        let waiterID = UUID()

        return await withCheckedContinuation { continuation in
            exitWaiters[waiterID] = continuation

            Task {
                try? await Task.sleep(for: .seconds(timeoutSeconds))
                resumeExitWaiter(waiterID, hasExited: false)
            }
        }
    }

    private func resumeExitWaiter(_ waiterID: UUID, hasExited: Bool) {
        exitWaiters.removeValue(forKey: waiterID)?.resume(returning: hasExited)
    }

    private func launch() {
        guard let configuration, !isStopping else {
            return
        }

        let process = Process()
        let standardInputPipe = Pipe()
        let standardOutputPipe = Pipe()
        let standardErrorPipe = Pipe()
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = configuration.path
        environment["PRB_TOKEN"] = token

        process.executableURL = configuration.bunURL
        process.arguments = ["src/main.ts"]
        process.currentDirectoryURL = configuration.serviceDirectory
        process.environment = environment
        process.standardInput = standardInputPipe
        process.standardOutput = standardOutputPipe
        process.standardError = standardErrorPipe
        process.terminationHandler = { [weak self] finishedProcess in
            Task { @MainActor in
                self?.handleTermination(of: finishedProcess)
            }
        }

        lineReaders = [
            PipeLineReader(pipe: standardOutputPipe) { [weak self] line in
                Task { @MainActor in
                    self?.handleOutputLine(line)
                }
            },
            PipeLineReader(pipe: standardErrorPipe) { line in
                switch ServiceLogLine.level(of: line) {
                case .error:
                    Logger.service.error("service: \(line, privacy: .public)")
                case .warning:
                    Logger.service.warning("service: \(line, privacy: .public)")
                case .info:
                    Logger.service.info("service: \(line, privacy: .public)")
                }
            },
        ]

        do {
            try process.run()
        } catch {
            Logger.service.error("Could not start \(configuration.bunURL.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            onExit?("Could not start bun")
            scheduleRestart()
            return
        }

        self.process = process
        self.standardInputPipe = standardInputPipe
        launchedAt = Date()
        Logger.service.info("Service started (pid \(process.processIdentifier)) in \(configuration.serviceDirectory.path, privacy: .public)")
    }

    private func handleOutputLine(_ line: String) {
        guard let port = ServiceListeningEvent.port(fromLine: line) else {
            Logger.service.debug("service stdout: \(line, privacy: .public)")
            return
        }

        Logger.service.info("Service listening on port \(port)")
        onListening?(port)
    }

    private func handleTermination(of finishedProcess: Process) {
        guard finishedProcess === process else {
            return
        }

        process = nil
        standardInputPipe = nil
        Logger.service.info("Service exited with status \(finishedProcess.terminationStatus)")

        for waiterID in exitWaiters.keys {
            resumeExitWaiter(waiterID, hasExited: true)
        }

        guard !isStopping else {
            return
        }

        onExit?("Service stopped, restarting…")

        if Date().timeIntervalSince(launchedAt) > Self.stableRunSeconds {
            restartDelaySeconds = 1
        }

        scheduleRestart()
    }

    private func scheduleRestart() {
        let delaySeconds = restartDelaySeconds
        restartDelaySeconds = min(restartDelaySeconds * 2, Self.maximumRestartDelaySeconds)
        Logger.service.info("Restarting service in \(delaySeconds) s")

        Task {
            try? await Task.sleep(for: .seconds(delaySeconds))
            launch()
        }
    }
}
