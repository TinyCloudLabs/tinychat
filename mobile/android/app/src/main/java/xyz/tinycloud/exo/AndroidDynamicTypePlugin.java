package xyz.tinycloud.exo;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidDynamicType")
public final class AndroidDynamicTypePlugin extends Plugin {
    @PluginMethod
    public void getFontScale(PluginCall call) {
        float fontScale = getActivity().getResources().getConfiguration().fontScale;
        JSObject result = new JSObject();
        result.put("fontScale", fontScale);
        call.resolve(result);
    }
}
