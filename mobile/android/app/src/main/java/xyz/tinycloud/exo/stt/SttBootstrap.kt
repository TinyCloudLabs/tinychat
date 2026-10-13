package xyz.tinycloud.exo.stt

import android.content.Context
import android.os.Looper
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
        // Deferred to the main looper's next idle point (after the first frame is up), not run
        // synchronously from here: a note that reliably crashes the decode must never compete with
        // app launch for CPU/memory before the UI exists (TC-836 incident, a crash-looping note).
        Looper.myQueue().addIdleHandler {
            queue.reconcile()
            false // run once
        }
        // `CaptureBootstrap.onProcessStart` runs recovery on its own background thread; this
        // catches a note recovery commits after the scan above already ran.
        Thread { Thread.sleep(3000); queue.reconcile() }.start()
    }
}
