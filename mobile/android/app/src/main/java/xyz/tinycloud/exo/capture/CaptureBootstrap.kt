package xyz.tinycloud.exo.capture

import android.content.Context
import android.util.Log

object CaptureBootstrap {
    fun onProcessStart(context: Context) {
        LaunchCommandStore(context).pending() // discard an expired command, if any
        CaptureSurfaces.install(context)
        // Recovery is independent of the WebView, and durable sessions are immediately discoverable.
        Thread {
            try { CaptureEngine.get(context).recover() }
            catch (e: Exception) { Log.e("ExoCapture", "Recovery failed", e) }
        }.start()
    }
}
