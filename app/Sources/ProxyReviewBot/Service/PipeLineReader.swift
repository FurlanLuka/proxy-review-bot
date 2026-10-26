import Foundation

final class PipeLineReader {
    private var buffer = Data()
    private let onLine: (String) -> Void

    init(pipe: Pipe, onLine: @escaping (String) -> Void) {
        self.onLine = onLine
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData

            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }

            self?.append(data)
        }
    }

    private func append(_ data: Data) {
        buffer.append(data)

        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[buffer.startIndex..<newlineIndex]
            buffer.removeSubrange(buffer.startIndex...newlineIndex)

            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                onLine(line)
            }
        }
    }
}
