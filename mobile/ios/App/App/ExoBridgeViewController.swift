import Capacitor
import UIKit

/// Registers Exo's app-local plugins with the Capacitor bridge.
/// Main.storyboard uses this class instead of CAPBridgeViewController.
class ExoBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceNotesPlugin())
    }
}
