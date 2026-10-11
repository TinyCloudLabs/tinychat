package xyz.tinycloud.exo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class ThemeBarsPluginTest {
    @Test public void parsesForcedLightAndDarkSurfaceColors() {
        assertEquals(0xFFFFFFFF, ThemeBarsPlugin.parseCssHexColor("#FFFFFF"));
        assertEquals(0xFF09090B, ThemeBarsPlugin.parseCssHexColor("#09090B"));
    }

    @Test public void rejectsUnexpectedColorFormats() {
        assertThrows(IllegalArgumentException.class, () -> ThemeBarsPlugin.parseCssHexColor("white"));
    }
}
