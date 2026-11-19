package xyz.tinycloud.exo.capture

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import xyz.tinycloud.exo.MainActivity
import xyz.tinycloud.exo.R
import xyz.tinycloud.exo.capture.core.LaunchSource

/**
 * Quick Settings "Record" tile. It never touches the mic itself: a microphone foreground service
 * must start while the app is visible (while-in-use rules), so it opens MainActivity with RECORD.
 */
class RecordTileService : TileService() {
    override fun onStartListening() {
        val tile = qsTile ?: return
        val live = !CaptureEngine.get(this).status().isNull("id")
        tile.state = if (live) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = getString(R.string.capture_tile_label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) tile.subtitle = getString(R.string.app_name)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) tile.stateDescription = if (live) getString(R.string.capture_recording) else null
        tile.updateTile()
    }

    override fun onClick() {
        if (isLocked) unlockAndRun { launch() } else launch()
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun launch() {
        val intent = launchIntent(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION") startActivityAndCollapse(intent)
        }
    }

    companion object {
        @JvmStatic fun launchIntent(context: Context): Intent =
            Intent(context, MainActivity::class.java).setAction(CaptureService.RECORD)
                .putExtra(LaunchSource.EXTRA, LaunchSource.TILE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}
