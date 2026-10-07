package xyz.tinycloud.exo

import android.app.Application
import xyz.tinycloud.exo.capture.CaptureBootstrap
import xyz.tinycloud.exo.stt.SttBootstrap

class ExoApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CaptureBootstrap.onProcessStart(this)
        SttBootstrap.onProcessStart(this)
    }
}
