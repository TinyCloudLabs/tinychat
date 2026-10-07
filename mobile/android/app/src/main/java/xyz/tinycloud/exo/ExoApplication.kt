package xyz.tinycloud.exo

import android.app.Application
import xyz.tinycloud.exo.capture.CaptureBootstrap

class ExoApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CaptureBootstrap.onProcessStart(this)
        // SttBootstrap.onProcessStart(this) is added by T8.
    }
}
