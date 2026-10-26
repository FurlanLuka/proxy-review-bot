import SwiftUI

struct ToolPathField: View {
    let name: String
    @Binding var path: String?

    var body: some View {
        TextField(name, text: text, prompt: Text("Look up on PATH"))
    }

    private var text: Binding<String> {
        Binding {
            path ?? ""
        } set: { newValue in
            let trimmedValue = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            path = trimmedValue.isEmpty ? nil : trimmedValue
        }
    }
}
