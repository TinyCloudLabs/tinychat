/// Per-session recovery errors are reported for that id and never prevent later sessions
/// from being recovered or a new live session from starting.
public enum CaptureRecoverySweep {
    public static func run(ids: [String], recover: (String) throws -> Void,
                           failed: (String, Error) -> Void) {
        for id in ids {
            do { try recover(id) }
            catch { failed(id, error) }
        }
    }
}
