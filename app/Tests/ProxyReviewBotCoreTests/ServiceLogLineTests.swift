import ProxyReviewBotCore
import XCTest

final class ServiceLogLineTests: XCTestCase {
    func testUsesTheServiceLogLevel() {
        XCTAssertEqual(ServiceLogLine.level(of: #"{"level":"info","event":"gh_call"}"#), .info)
        XCTAssertEqual(ServiceLogLine.level(of: #"{"level":"warn","event":"usage_limited"}"#), .warning)
        XCTAssertEqual(ServiceLogLine.level(of: #"{"level":"error","event":"job_failed"}"#), .error)
    }

    func testUnstructuredOutputIsTreatedAsAnError() {
        XCTAssertEqual(ServiceLogLine.level(of: "panic: something broke"), .error)
    }
}
