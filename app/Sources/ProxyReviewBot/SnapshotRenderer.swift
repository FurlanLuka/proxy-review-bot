import AppKit
import OSLog
import ProxyReviewBotCore
import SwiftUI

@MainActor
enum SnapshotRenderer {
    static let environmentKey = "PRB_RENDER_SNAPSHOTS"

    static var outputDirectory: URL? {
        ProcessInfo.processInfo.environment[environmentKey].map { URL(fileURLWithPath: $0) }
    }

    static func renderWhenReady(model: BotModel, into directory: URL) {
        if ProcessInfo.processInfo.environment["PRB_RENDER_APPEARANCE"] == "light" {
            NSApp.appearance = NSAppearance(named: .aqua)
        }

        Task {
            while model.state == nil || model.state?.readiness.status == .checking {
                try? await Task.sleep(for: .milliseconds(200))
            }

            try? await Task.sleep(for: .seconds(1))
            let size = MainWindowController.defaultSize
            await render(
                HomeView(model: model)
                    .environmentObject(AppNavigator())
                    .frame(width: size.width, height: size.height),
                name: "menu",
                into: directory
            )
            await render(SettingsView(model: model).frame(width: size.width, height: size.height), name: "settings", into: directory)

            if let state = model.state {
                await render(
                    SettingsFormView(model: model, settings: .constant(state.settings), readiness: state.readiness)
                        .frame(width: 520, height: 1180),
                    name: "settings-full",
                    into: directory
                )
            }
            if let manualStart = model.state?.pullRequests.filter(\.isWaitingForManualStart), !manualStart.isEmpty {
                await render(
                    VStack(spacing: 12) {
                        ForEach(manualStart) { pullRequest in
                            PullRequestRowView(model: model, pullRequest: pullRequest, isProgressExpanded: false)
                        }
                    }
                    .environmentObject(AppNavigator())
                    .padding(12).frame(width: size.width - HomeView.padding * 2),
                    name: "manual-start",
                    into: directory
                )
            }
            await render(
                PullRequestRowView(model: model, pullRequest: sampleReviewingPullRequest(), isProgressExpanded: true)
                    .environmentObject(AppNavigator())
                    .padding(12).frame(width: size.width - HomeView.padding * 2),
                name: "progress",
                into: directory
            )
            await render(
                Form { UninstallSection(model: model) }
                    .formStyle(.grouped)
                    .frame(width: 520, height: 130),
                name: "uninstall",
                into: directory
            )
            await render(
                DraftEditorContentView(
                    pullRequest: sampleDraftPullRequest(),
                    draft: sampleDraft(),
                    onPost: { _ in },
                    onDiscard: {},
                    onFinish: {}
                )
                .frame(width: size.width, height: size.height),
                name: "draft",
                into: directory
            )
            await render(
                DraftEditorContentView(
                    pullRequest: sampleOwnDraftPullRequest(),
                    draft: sampleDraft(),
                    onPost: { _ in },
                    onDiscard: {},
                    onFinish: {}
                )
                .frame(width: size.width, height: size.height),
                name: "draft-own",
                into: directory
            )
            await render(
                AddPullRequestRow(model: model, onAdded: { _ in }, onClose: {})
                    .padding(HomeView.padding)
                    .frame(width: size.width),
                name: "add-row",
                into: directory
            )
            await render(
                HistoryContentView(entries: sampleHistory(), now: Date())
                    .frame(width: size.width, height: size.height),
                name: "history",
                into: directory
            )
            NSApp.terminate(nil)
        }
    }

    private static func sampleHistory() -> [HistoryEntry] {
        let now = Date().timeIntervalSince1970 * 1000
        let hour = 3_600_000.0
        let samples: [(repo: String, title: String, number: Int, author: String, outcome: String, rounds: Int, hoursAgo: Double)] = [
            ("api", "Fix auth retry", 412, "ana", "approved_by_bot", 2, 1),
            ("web", "Dark mode tokens", 91, "sam", "merged", 3, 3),
            ("billing", "Invoice export", 201, "kai", "taken_over", 1, 27),
            ("search", "Reindex job", 5, "mo", "closed", 1, 30),
            ("docs", "Update setup guide", 19, "lee", "approved_by_you", 2, 52),
            ("ios", "Widget refresh", 77, "ana", "stopped", 0, 75),
        ]
        let entries = samples.enumerated().map { index, sample -> [String: Any] in
            [
                "id": index + 1, "owner": "acme", "repo": sample.repo, "number": sample.number, "title": sample.title,
                "url": "https://github.com/acme/\(sample.repo)/pull/\(sample.number)", "author": sample.author,
                "outcome": sample.outcome, "rounds": sample.rounds, "finishedAt": now - sample.hoursAgo * hour,
            ]
        }
        let data = try! JSONSerialization.data(withJSONObject: ["entries": entries])

        return try! JSONDecoder().decode(HistoryResponse.self, from: data).entries
    }

    private static func sampleDraftPullRequest() -> PullRequest {
        let json = """
        {
            "id": 9998, "owner": "acme", "repo": "api", "number": 412, "title": "Fix auth retry",
            "url": "https://github.com/acme/api/pull/412", "author": "ana", "status": "draft_ready",
            "rounds": 1, "maxRounds": 5, "additions": 84, "deletions": 12, "headSha": "abc123",
            "summary": "Retry loop never backs off", "reason": null, "reviewStartedAt": null, "updatedAt": 1793015179000,
            "draft": { "filing": "approve", "summary": "Retry loop never backs off", "commentCount": 2 }
        }
        """

        return try! JSONDecoder().decode(PullRequest.self, from: Data(json.utf8))
    }

    private static func sampleOwnDraftPullRequest() -> PullRequest {
        var pullRequest = sampleDraftPullRequest()
        pullRequest.isOwn = true
        pullRequest.source = .link

        return pullRequest
    }

    private static func sampleDraft() -> ReviewDraft {
        let json = """
        {
            "headSha": "abc123",
            "filing": "approve",
            "summary": "Retry loop never backs off",
            "mainReview": "Looks good overall. The retry loop needs a backoff before this ships, otherwise a flaky upstream gets hammered.",
            "comments": [
                { "path": "src/auth/retry.ts", "line": 12, "side": "RIGHT", "body": "No delay between attempts. Consider exponential backoff with jitter." },
                { "path": "src/auth/retry.test.ts", "line": 48, "side": "RIGHT", "body": "This test passes even when the retry count is ignored." }
            ],
            "fileComments": [{ "path": "src/auth/legacyRetry.ts", "body": "Nothing imports this anymore, so the file can go." }],
            "coverage": "Checked the retry paths and the token refresh flow; couldn't run the integration tests."
        }
        """

        return try! JSONDecoder().decode(ReviewDraft.self, from: Data(json.utf8))
    }

    private static func sampleReviewingPullRequest() -> PullRequest {
        let now = Date().timeIntervalSince1970 * 1000
        let minute = 60_000.0

        func subagent(_ id: Int, _ label: String, _ description: String, _ status: String, finishedMinutesAgo: Double?, step: String? = nil) -> [String: Any] {
            [
                "id": "\(id)",
                "agentType": label,
                "label": label,
                "description": description,
                "status": status,
                "currentStep": step ?? NSNull(),
                "startedAt": now - 6 * minute,
                "finishedAt": finishedMinutesAgo.map { now - $0 * minute } ?? NSNull(),
            ]
        }

        let sample: [String: Any] = [
            "id": 9999, "owner": "acme", "repo": "billing", "number": 201, "title": "Invoice export",
            "url": "https://github.com/acme/billing/pull/201", "author": "kai", "status": "reviewing",
            "rounds": 1, "maxRounds": 5, "additions": 120, "deletions": 30, "headSha": "sample",
            "reviewStartedAt": now - 7 * minute, "updatedAt": now,
            "progress": [
                "phase": "review",
                "message": "Waiting on 2 advisors, then verifying findings",
                "updatedAt": now,
                "subagents": [
                    subagent(1, "Product", "Scope and UX of the export", "completed", finishedMinutesAgo: 4),
                    subagent(2, "Architecture", "Module boundaries for export", "completed", finishedMinutesAgo: 3),
                    subagent(3, "Clean code", "Structure and naming", "running", finishedMinutesAgo: nil, step: "Reading src/export/invoice.ts"),
                    subagent(4, "Tests", "Coverage of the export job", "running", finishedMinutesAgo: nil, step: "Running git show on the spec"),
                    subagent(5, "code-review", "Correctness pass", "completed", finishedMinutesAgo: 2),
                ],
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: sample)

        return try! JSONDecoder().decode(PullRequest.self, from: data)
    }

    private static func render<Content: View>(_ content: Content, name: String, into directory: URL) async {
        let hostingView = NSHostingView(rootView: content.background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: hostingView.fittingSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        window.contentView = hostingView
        hostingView.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(300))

        let size = hostingView.fittingSize
        window.setContentSize(size)
        hostingView.frame = NSRect(origin: .zero, size: size)
        hostingView.layoutSubtreeIfNeeded()

        guard let bitmap = hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds) else {
            Logger.app.error("Snapshot \(name, privacy: .public) could not allocate a bitmap")
            return
        }

        hostingView.cacheDisplay(in: hostingView.bounds, to: bitmap)

        let fileURL = directory.appendingPathComponent("\(name).png")

        do {
            try bitmap.representation(using: .png, properties: [:])?.write(to: fileURL)
            Logger.app.info("Snapshot written to \(fileURL.path, privacy: .public)")
        } catch {
            Logger.app.error("Snapshot \(name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}

