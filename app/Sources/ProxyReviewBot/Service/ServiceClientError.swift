import Foundation
import ProxyReviewBotCore

enum ServiceClientError: LocalizedError {
    case invalidResponse
    case notConnected
    case failed(statusCode: Int, code: String?, reason: String?)

    var code: String? {
        if case .failed(_, let code, _) = self {
            return code
        }

        return nil
    }

    static func message(for error: Error, subject: String) -> String {
        guard case .failed(let statusCode, let code, let reason) = error as? ServiceClientError,
              let message = ServiceErrorText.message(statusCode: statusCode, code: code, reason: reason, subject: subject)
        else {
            return error.localizedDescription
        }

        return message
    }

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The service sent an invalid response"
        case .notConnected:
            return "The service isn't running"
        case .failed(let statusCode, let code, _):
            return "The service returned \(statusCode)\(code.map { " (\($0))" } ?? "")"
        }
    }
}
