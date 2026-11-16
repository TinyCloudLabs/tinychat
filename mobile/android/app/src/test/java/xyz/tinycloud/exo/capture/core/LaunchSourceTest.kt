package xyz.tinycloud.exo.capture.core

import org.junit.Assert.assertEquals
import org.junit.Test

class LaunchSourceTest {
    @Test fun tileExtraMapsToTileSource() = assertEquals("tile", LaunchSource.record("tile"))

    @Test fun missingOrUnknownExtraIsAppShortcut() {
        assertEquals("app_shortcut", LaunchSource.record(null))
        assertEquals("app_shortcut", LaunchSource.record("widget"))
        assertEquals("app_shortcut", LaunchSource.record("in_app"))
    }
}
