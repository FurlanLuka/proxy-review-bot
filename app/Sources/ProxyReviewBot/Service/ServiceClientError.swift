import Foundation

enum ServiceClientError: LocalizedError {
    case invalidResponse
    case failed(statusCode: Int, code: String?)

    var code: String? {
        if case .failed(_, let code) = self {
            return code
        }

        return nil
    }

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The service sent an invalid response"
        case .failed(let statusCode, let code):
            return "The service returned \(statusCode)\(code.map { " (\($0))" } ?? "")"
        }
    }
}
