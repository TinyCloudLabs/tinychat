package xyz.tinycloud.exo;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Debug-only, structured app diagnostics. No bridge arguments or results are logged. */
@CapacitorPlugin(name = "ExoDevLog")
public class ExoDevLogPlugin extends Plugin {
    @PluginMethod
    public void append(PluginCall call) {
        if (BuildConfig.DEBUG) {
            String line = call.getString("line");
            if (line != null && line.length() < 8192) {
                try {
                    JSObject object = new JSObject(line);
                    if (object.has("at") && object.has("kind") && object.has("source_id")) {
                        Log.i("ExoDev", line);
                    }
                } catch (Exception ignored) { }
            }
        }
        call.resolve();
    }
}
