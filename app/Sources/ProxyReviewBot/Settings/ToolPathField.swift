import SwiftUI

struct ToolPathField: View {
    let label: String
    @Binding var path: String?

    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        TextField(label, text: $text, prompt: Text("Look up on PATH"))
            .focused($isFocused)
            .onSubmit(commit)
            .onChange(of: isFocused) { _, isNowFocused in
                if !isNowFocused {
                    commit()
                }
            }
            .onAppear { text = path ?? "" }
            .onChange(of: path) { _, newPath in
                if !isFocused {
                    text = newPath ?? ""
                }
            }
    }

    private func commit() {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        path = trimmedText.isEmpty ? nil : trimmedText
    }
}
