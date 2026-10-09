package xyz.tinycloud.exo.capture.core

/** Keeps launch recovery single-shot and lets readers wait for a consistent library view. */
class RecoveryCoordinator {
    private val monitor = Object()
    private var launchStarted = false
    private var scanning = false

    fun beginLaunch(execute: (() -> Unit) -> Unit, scan: () -> Unit) {
        synchronized(monitor) {
            if (launchStarted) return
            launchStarted = true
            scanning = true
        }
        try {
            execute { finish(scan) }
        } catch (error: Throwable) {
            synchronized(monitor) { scanning = false; monitor.notifyAll() }
            throw error
        }
    }

    fun await() = synchronized(monitor) {
        while (scanning) monitor.wait()
    }

    fun explicit(scan: () -> Unit) {
        synchronized(monitor) {
            while (scanning) monitor.wait()
            scanning = true
        }
        finish(scan)
    }

    private fun finish(scan: () -> Unit) {
        try { scan() }
        finally { synchronized(monitor) { scanning = false; monitor.notifyAll() } }
    }
}
