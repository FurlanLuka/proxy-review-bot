import Foundation

public enum HistoryOutcome: String, Codable, Equatable, Sendable {
    case approvedByBot = "approved_by_bot"
    case approvedByYou = "approved_by_you"
    case merged
    case closed
    case takenOver = "taken_over"
    case stopped
    case unknown

    public init(from decoder: Decoder) throws {
        let rawValue = try decoder.singleValueContainer().decode(String.self)
        self = HistoryOutcome(rawValue: rawValue) ?? .unknown
    }

    public var displayName: String {
        switch self {
        case .approvedByBot:
            return "Approved by bot"
        case .approvedByYou:
            return "Approved"
        case .merged:
            return "Merged"
        case .closed:
            return "Closed"
        case .takenOver:
            return "You reviewed it"
        case .stopped:
            return "Stopped"
        case .unknown:
            return "Finished"
        }
    }
}

public struct HistoryEntry: Codable, Equatable, Identifiable, Sendable {
    public var id: Int
    public var owner: String
    public var repo: String
    public var number: Int
    public var title: String
    public var url: URL
    public var author: String
    public var outcome: HistoryOutcome
    public var rounds: Int
    public var finishedAt: Double

    public var finishedAtDate: Date {
        Date(timeIntervalSince1970: finishedAt / 1000)
    }

    public var subtitle: String {
        "\(repo) #\(number) · @\(author)"
    }

    public var roundsText: String {
        rounds == 1 ? "1 round" : "\(rounds) rounds"
    }
}

public struct HistoryResponse: Decodable, Equatable, Sendable {
    public var entries: [HistoryEntry]
}

public struct HistoryDay: Equatable, Identifiable, Sendable {
    public let id: Date
    public let title: String
    public let entries: [HistoryEntry]
}

public enum HistoryGrouping {
    public static func days(
        for entries: [HistoryEntry],
        now: Date,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [HistoryDay] {
        let sortedEntries = entries.sorted { $0.finishedAt > $1.finishedAt }
        let entriesByDay = Dictionary(grouping: sortedEntries) { calendar.startOfDay(for: $0.finishedAtDate) }

        return entriesByDay.keys
            .sorted(by: >)
            .map { day in
                HistoryDay(
                    id: day,
                    title: title(for: day, now: now, calendar: calendar, locale: locale),
                    entries: entriesByDay[day] ?? []
                )
            }
    }

    public static func title(for day: Date, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        if calendar.isDate(day, inSameDayAs: now) {
            return "Today"
        }

        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) {
            return "Yesterday"
        }

        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            .weekday(.abbreviated)
            .day()
            .month(.abbreviated)

        return day.formatted(style)
    }
}
