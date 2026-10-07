package xyz.tinycloud.exo.capture

import android.media.MediaExtractor
import android.media.MediaFormat
import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.app.NotificationManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import xyz.tinycloud.exo.capture.core.MAX_DURATION_MS
import xyz.tinycloud.exo.capture.core.RecordingLibrary
import xyz.tinycloud.exo.capture.core.defaultOptions
import java.io.File
import java.util.UUID
import xyz.tinycloud.exo.MainActivity
import kotlin.math.PI
import kotlin.math.sin

@RunWith(AndroidJUnit4::class)
class CaptureInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun grant(permission: String) {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("pm grant ${context.packageName} $permission")
        ).use { it.readBytes() }
    }
    @Test fun encodeFinalizeAndProbe44100Hz() {
        val root = File(context.cacheDir, "capture-test-${UUID.randomUUID()}")
        val library = RecordingLibrary(root, AndroidFileOps())
        val id = UUID.randomUUID().toString()
        try {
            library.start(id, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
            var packets = 0
            val encoder = AacAdtsEncoder { library.append(id, 0, it); packets++ }
            val samples = 44_100
            val pcm = ByteArray(samples * 2)
            for (i in 0 until samples) {
                val value = (sin(2 * PI * 440 * i / samples) * 5000).toInt().toShort().toInt()
                pcm[i * 2] = value.toByte(); pcm[i * 2 + 1] = (value shr 8).toByte()
            }
            encoder.offer(pcm, pcm.size); encoder.finish()
            assertTrue(packets > 40)
            val audioMs = packets * 1024L * 1000 / 44_100
            library.checkpoint(id, 0, audioMs, "recording", "available")
            library.stopJournal(id, audioMs, "user")
            val note = library.commit(id, { RecordingFinalizer.mux(library.session(id), it) })
            assertFalse(library.session(id).exists())
            assertTrue(library.sidecar(id).exists())
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(library.audio(id).absolutePath)
                assertEquals(1, extractor.trackCount)
                val format = extractor.getTrackFormat(0)
                assertEquals(MediaFormat.MIMETYPE_AUDIO_AAC, format.getString(MediaFormat.KEY_MIME))
                assertEquals(44_100, format.getInteger(MediaFormat.KEY_SAMPLE_RATE))
                assertEquals(1, format.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
                assertTrue(kotlin.math.abs(format.getLong(MediaFormat.KEY_DURATION) / 1000 - note.getLong("durationMs")) < 100)
                assertNotNull(LegacyProbe.inspect(library.audio(id)))
            } finally { extractor.release() }
        } finally { root.deleteRecursively() }
    }
    @Test fun launchCommandSurvivesRecreationAndExpires() {
        val first = LaunchCommandStore(context).put("RECORD", "app_shortcut")
        val restored = LaunchCommandStore(context).pending()
        assertEquals(first.id, restored?.id)
        assertEquals("app_shortcut", restored?.source)
        assertNull(LaunchCommandStore(context).pending(first.createdAt + 30_001))
    }
    @Test fun visibleAppShortcutStartsNativeCapture() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        assertEquals(PackageManager.PERMISSION_GRANTED,
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO))
        val launch = Intent(context, MainActivity::class.java).setAction(CaptureService.RECORD)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(launch)
        try {
            val engine = CaptureEngine.get(context)
            val deadline = System.currentTimeMillis() + 5000
            while (engine.status().optString("state") != "recording" && System.currentTimeMillis() < deadline) Thread.sleep(50)
            assertEquals("recording", engine.status().getString("state"))
            assertEquals("app_shortcut", engine.status().getString("source"))
            Thread.sleep(1100)
            val liveId = engine.status().getString("id")
            engine.pause()
            assertEquals("paused", engine.status().getString("state"))
            val atPause = engine.library.events(liveId)
            val pausedIndex = atPause.indexOfLast { it.optString("e") == "intent" && it.optString("value") == "paused" }
            val hbIndex = atPause.indexOfLast { it.optString("e") == "hb" }
            assertTrue("pause must checkpoint before intent", hbIndex >= 0 && hbIndex < pausedIndex)
            assertEquals(File(engine.library.session(liveId), "seg-00000.aac").length(), atPause[hbIndex].getLong("segBytes"))
            assertEquals(atPause[hbIndex].getLong("t"), atPause[pausedIndex].getLong("t"))
            assertEquals(atPause[hbIndex].getLong("a"), atPause[pausedIndex].getLong("a"))
            Thread.sleep(1000)
            assertEquals(atPause.size, engine.library.events(liveId).size)
            engine.resume()
            assertEquals("recording", engine.status().getString("state"))
            Thread.sleep(1100)
            val note = engine.stop()
            assertTrue(note.getLong("durationMs") >= 500)
            assertTrue(note.getLong("pausedMs") >= 900)
            assertTrue(engine.library.audio(note.getString("id")).isFile)
            context.stopService(Intent(context, CaptureService::class.java))
            engine.library.delete(note.getString("id"))
        } finally { activity.finish() }
    }
    @Test fun motoScreenOffStopThroughNotificationAction() {
        assumeTrue("Moto hardware check", Build.MANUFACTURER.equals("motorola", ignoreCase = true))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        val power = context.getSystemService(PowerManager::class.java)
        try {
            val startDeadline = System.currentTimeMillis() + 5000
            while (engine.status().optString("state") != "recording" && System.currentTimeMillis() < startDeadline) Thread.sleep(50)
            assertEquals("recording", engine.status().getString("state"))
            val id = engine.status().getString("id")
            if (power.isInteractive) instrumentation.uiAutomation.executeShellCommand("input keyevent 26").close()
            Thread.sleep(61_000)
            assertEquals("recording", engine.status().getString("state"))
            val notification = context.getSystemService(NotificationManager::class.java).activeNotifications
                .firstOrNull { it.id == 7201 }?.notification ?: error("Capture notification missing")
            val stop = notification.actions.firstOrNull { it.title.toString() == context.getString(xyz.tinycloud.exo.R.string.capture_stop) }
                ?: error("Stop notification action missing")
            stop.actionIntent.send()
            val stopDeadline = System.currentTimeMillis() + 10_000
            while (!engine.status().isNull("id") && System.currentTimeMillis() < stopDeadline) Thread.sleep(100)
            assertTrue("notification Stop did not commit", engine.status().isNull("id"))
            val note = engine.library.read(id) ?: error("Committed sidecar missing")
            assertTrue("screen-off capture too short", note.getLong("durationMs") >= 55_000)
            Log.i("ExoCapture", "T5_MOTO_NOTE id=$id durationMs=${note.getLong("durationMs")}")
        } finally {
            if (!power.isInteractive) instrumentation.uiAutomation.executeShellCommand("input keyevent 26").close()
            if (!engine.status().isNull("id")) {
                engine.stop()
                context.stopService(Intent(context, CaptureService::class.java))
            }
            activity.finish()
        }
    }
}
