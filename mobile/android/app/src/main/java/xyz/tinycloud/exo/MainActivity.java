package xyz.tinycloud.exo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import xyz.tinycloud.exo.health.HealthPlugin;
import xyz.tinycloud.exo.voicenotes.VoiceNotesPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceNotesPlugin.class);
        registerPlugin(HealthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
