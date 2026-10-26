public struct IncludableItem<Item: Equatable & Sendable>: Equatable, Identifiable, Sendable {
    public let id: Int
    public var item: Item
    public var isIncluded = true
}

public struct EditableReviewDraft: Equatable, Sendable {
    public let draft: ReviewDraft
    public var event: ReviewEvent
    public var mainReview: String
    public var comments: [IncludableItem<ReviewDraftComment>]
    public var fileComments: [IncludableItem<ReviewDraftFileComment>]

    public init(draft: ReviewDraft) {
        self.draft = draft
        event = draft.filing.defaultEvent
        mainReview = draft.mainReview
        comments = draft.comments.enumerated().map { IncludableItem(id: $0.offset, item: $0.element) }
        fileComments = draft.fileComments.enumerated().map { IncludableItem(id: $0.offset, item: $0.element) }
    }

    public var canApprove: Bool {
        draft.filing == .approve
    }

    public var availableEvents: [ReviewEvent] {
        canApprove ? [.approve, .comment, .requestChanges] : [.comment, .requestChanges]
    }

    public var unpostableReason: String? {
        let includedBodies = comments.filter(\.isIncluded).map(\.item.body)
            + fileComments.filter(\.isIncluded).map(\.item.body)

        if !includedBodies.allSatisfy({ !Self.isBlank($0) }) {
            return "Every included comment needs some text"
        }

        if postRequest.event == .requestChanges && includedBodies.isEmpty && Self.isBlank(mainReview) {
            return "Requesting changes needs a review or a comment"
        }

        return nil
    }

    public var isPostable: Bool {
        unpostableReason == nil
    }

    public var postRequest: ReviewPostRequest {
        ReviewPostRequest(
            headSha: draft.headSha,
            event: availableEvents.contains(event) ? event : .comment,
            mainReview: mainReview,
            comments: comments.filter(\.isIncluded).map(\.item),
            fileComments: fileComments.filter(\.isIncluded).map(\.item)
        )
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
