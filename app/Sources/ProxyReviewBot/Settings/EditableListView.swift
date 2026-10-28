import SwiftUI

struct EditableListView: View {
    let title: String
    let placeholder: String
    @Binding var entries: [String]
    var normalize: (String) -> String? = { $0 }

    @State private var newEntry = ""

    var body: some View {
        LabeledContent(title) {
            VStack(alignment: .trailing, spacing: 4) {
                ForEach(entries, id: \.self) { entry in
                    HStack {
                        Text(entry)
                            .textSelection(.enabled)

                        Button {
                            entries.removeAll { $0 == entry }
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .help("Remove \(entry)")
                        .accessibilityLabel("Remove \(entry)")
                    }
                }

                HStack {
                    TextField(title, text: $newEntry, prompt: Text(placeholder))
                        .labelsHidden()
                        .onSubmit(addEntry)

                    Button(action: addEntry) {
                        Image(systemName: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    .disabled(normalizedNewEntry == nil)
                    .help("Add to \(title) list")
                    .accessibilityLabel("Add to \(title) list")
                }
            }
        }
    }

    private var normalizedNewEntry: String? {
        let trimmed = newEntry.trimmingCharacters(in: .whitespacesAndNewlines)

        return trimmed.isEmpty ? nil : normalize(trimmed)
    }

    private func addEntry() {
        guard let entry = normalizedNewEntry, !entries.contains(entry) else {
            return
        }

        entries.append(entry)
        newEntry = ""
    }
}
