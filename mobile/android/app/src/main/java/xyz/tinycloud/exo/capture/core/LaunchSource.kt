package xyz.tinycloud.exo.capture.core

/** Maps the RECORD intent's source extra to a capture source; unknown values fall back to the launcher shortcut. */
object LaunchSource {
    const val EXTRA = "xyz.tinycloud.exo.capture.extra.SOURCE"
    const val APP_SHORTCUT = "app_shortcut"
    const val TILE = "tile"
    private val allowed = setOf(TILE)

    @JvmStatic fun record(extra: String?): String = if (extra in allowed) extra!! else APP_SHORTCUT
}
