package xyz.tinycloud.exo;

import android.os.Build;
import android.view.Window;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ThemeBars")
public class ThemeBarsPlugin extends Plugin {
    static int parseCssHexColor(String value) {
        if (value == null || !value.matches("#[0-9a-fA-F]{6}")) {
            throw new IllegalArgumentException("Expected a #RRGGBB color");
        }
        return 0xFF000000
            | (Integer.parseInt(value.substring(1, 3), 16) << 16)
            | (Integer.parseInt(value.substring(3, 5), 16) << 8)
            | Integer.parseInt(value.substring(5, 7), 16);
    }

    @PluginMethod
    public void setBackgroundColor(PluginCall call) {
        final int color;
        try {
            color = parseCssHexColor(call.getString("color"));
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage());
            return;
        }
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) window.setStatusBarColor(color);
            window.getDecorView().setBackgroundColor(color);
            call.resolve();
        });
    }
}
