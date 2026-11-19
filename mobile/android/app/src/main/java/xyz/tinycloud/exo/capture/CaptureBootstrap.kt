package xyz.tinycloud.exo.capture

import android.content.Context

object CaptureBootstrap {
    fun onProcessStart(context: Context) {
        LaunchCommandStore(context).pending() // discard an expired command, if any
        // Recovery is independent of the WebView, and durable sessions are immediately discoverable.
        CaptureEngine.get(context).beginLaunchRecovery()
    }
}
