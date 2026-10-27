import AppKit
import Combine
import ProxyReviewBotCore

@MainActor
final class StatusItemController: NSObject {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let model: BotModel
    private let onClick: () -> Void
    private var modelObservation: AnyCancellable?

    init(model: BotModel, onClick: @escaping () -> Void) {
        self.model = model
        self.onClick = onClick
        super.init()

        statusItem.button?.target = self
        statusItem.button?.action = #selector(buttonClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem.button?.imagePosition = .imageLeading
        updateButton()
        modelObservation = model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async {
                self?.updateButton()
            }
        }
    }

    @objc private func buttonClicked() {
        onClick()
    }

    private func updateButton() {
        guard let button = statusItem.button else {
            return
        }

        let appearance = StatusItemAppearance(state: model.state, attentionCount: model.attentionCount)
        let image = NSImage(systemSymbolName: appearance.symbolName, accessibilityDescription: nil)
        image?.isTemplate = true
        button.image = image
        button.title = appearance.countText
        button.setAccessibilityLabel(appearance.accessibilityLabel)
        button.toolTip = appearance.toolTip
    }
}
