import Foundation

public struct ServiceListeningEvent: Decodable, Equatable, Sendable {
    public var event: String
    public var port: Int

    public static func port(fromLine line: String) -> Int? {
        guard let data = line.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(ServiceListeningEvent.self, from: data),
              decoded.event == "listening"
        else {
            return nil
        }

        return decoded.port
    }
}
