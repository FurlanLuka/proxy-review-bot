import Foundation
import OSLog
import ProxyReviewBotCore

struct ServiceClient: Sendable {
    let baseURL: URL
    let token: String

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        return URLSession(configuration: configuration)
    }()

    init(port: Int, token: String) {
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.token = token
    }

    func fetchState() async throws -> BotState {
        let data = try await send(method: "GET", path: "/state")
        return try JSONDecoder().decode(BotState.self, from: data)
    }

    func perform(_ action: ServiceAction) async throws {
        _ = try await send(method: action.method, path: action.path, body: action.encodedBody())
    }

    func fetchDraft(pullRequestID: Int) async throws -> ReviewDraft {
        let action = ServiceAction.fetchDraft(pullRequestID: pullRequestID)
        let data = try await send(method: action.method, path: action.path)
        return try JSONDecoder().decode(ReviewDraft.self, from: data)
    }

    func saveSettings(_ settings: BotSettings) async throws -> BotSettings {
        let body = try JSONEncoder().encode(settings)
        let data = try await send(method: "PUT", path: "/settings", body: body)
        return try JSONDecoder().decode(BotSettings.self, from: data)
    }

    private func send(method: String, path: String, body: Data? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        do {
            let (data, response) = try await Self.session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw ServiceClientError.invalidResponse
            }

            guard (200..<300).contains(httpResponse.statusCode) else {
                let errorResponse = try? JSONDecoder().decode(ServiceErrorResponse.self, from: data)
                throw ServiceClientError.failed(
                    statusCode: httpResponse.statusCode,
                    code: errorResponse?.error,
                    reason: errorResponse?.reason
                )
            }

            return data
        } catch {
            Logger.client.error("\(method, privacy: .public) \(path, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }
}
