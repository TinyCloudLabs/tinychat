package xyz.tinycloud.exo.stt

import android.content.Context
import xyz.tinycloud.exo.capture.CaptureEngine

/**
 * `SttWorker`/WorkManager (T24) is not added in this slice: on-device transcription only runs
 * while the app process is alive (TC-836 report, deviations).
 */
object SttBootstrap {
    private var observerInstalled = false

    fun onProcessStart(context: Context) {
        val queue = TranscriptionQueue.get(context)
        if (!observerInstalled) {
            observerInstalled = true
            CaptureEngine.get(context).addListener(object : CaptureEngine.Listener {
                override fun event(name: String, data: org.json.JSONObject) {
                    if (name == "committed" || name == "recovered") queue.reconcile()
                }
            })
        }
        queue.reconcile()
        // `CaptureBootstrap.onProcessStart` runs recovery on its own background thread; this
        // catches a note recovery commits after the scan above already ran.
        Thread { Thread.sleep(3000); queue.reconcile() }.start()
    }
}
