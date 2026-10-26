enum ServiceConnection: Equatable {
    case starting
    case connected
    case unavailable(message: String)
}
