import CryptoKit
import Foundation

public enum DiffLink {
    public static func fileURL(pullRequestURL: URL, path: String) -> URL {
        URL(string: "\(pullRequestURL.absoluteString)/files#diff-\(pathHash(path))") ?? pullRequestURL
    }

    public static func lineURL(pullRequestURL: URL, path: String, line: Int, side: String) -> URL {
        let sideLetter = side.uppercased() == "LEFT" ? "L" : "R"

        return URL(string: "\(pullRequestURL.absoluteString)/files#diff-\(pathHash(path))\(sideLetter)\(line)")
            ?? pullRequestURL
    }

    private static func pathHash(_ path: String) -> String {
        SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
