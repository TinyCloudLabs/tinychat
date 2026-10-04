package xyz.tinycloud.exo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import xyz.tinycloud.exo.health.HealthPlugin;
import xyz.tinycloud.exo.location.LocationPlugin;
import xyz.tinycloud.exo.voicenotes.VoiceNotesPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceNotesPlugin.class);
        registerPlugin(HealthPlugin.class);
        // TC-524 location spike. Registered in every build, but only the debug manifest (src/debug) declares the
        // location permissions and the location foreground service, so a release build cannot capture: its
        // status() reports declared.foreground = false and start() is refused.
        registerPlugin(LocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
