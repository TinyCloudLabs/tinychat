package xyz.tinycloud.exo.capture

import android.Manifest
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assume.assumeTrue
import xyz.tinycloud.exo.MainActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class TransitionInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun await(engine: CaptureEngine, state: String) {
        val end = System.currentTimeMillis() + 10_000
        while (engine.status().optString("state") != state && System.currentTimeMillis() < end) Thread.sleep(50)
        assertEquals(state, engine.status().optString("state"))
    }

    private fun awaitAttached(engine: CaptureEngine) {
        val end = System.currentTimeMillis() + 10_000
        while (!engine.hasAttachedInputForTest() && System.currentTimeMillis() < end) Thread.sleep(50)
        assertTrue("recording never attached an AudioRecord: ${engine.status()}", engine.hasAttachedInputForTest())
    }

    @Test fun pausedNotificationResumesAndStaleResumeIsIgnored() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            await(engine, "recording")
            awaitAttached(engine)
            val old = CaptureNotifications.action(context, CaptureService.ACTION_RESUME, 88, engine.status())
            engine.pause(); await(engine, "paused")
            old.send(); Thread.sleep(300)
            assertEquals("paused", engine.status().optString("state"))
            engine.resume(); await(engine, "recording")
            engine.stop()
        } finally {
            engine.startBeforeAttach = null
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun inFlightResumeInvalidatedByPauseStopAndDiscard() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        val audioManager = context.getSystemService(AudioManager::class.java)
        try {
            for (ending in listOf("pause", "stop", "discard")) {
                await(engine, "recording")
                awaitAttached(engine)
                val currentId = engine.status().getString("id")
                Thread.sleep(400)
                engine.pause()
                val entered = CountDownLatch(1)
                val release = CountDownLatch(1)
                engine.startBeforeAttach = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
                val worker = Thread { runCatching { engine.resume() } }
                try {
                    worker.start()
                    assertTrue("Resume never reached start.beforeAttach", entered.await(5, TimeUnit.SECONDS))
                    when (ending) {
                        "pause" -> engine.pause()
                        "stop" -> engine.stop()
                        else -> engine.discard()
                    }
                } finally {
                    release.countDown(); worker.join(10_000); engine.startBeforeAttach = null
                }
                assertFalse("in-flight Resume did not finish", worker.isAlive)
                assertTrue("AudioRecord was left active after $ending",
                    audioManager.activeRecordingConfigurations.none { it.clientAudioSource == android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION })
                if (ending == "pause") {
                    assertEquals("paused", engine.status().optString("state"))
                    engine.resume()
                } else {
                    assertTrue(engine.status().isNull("id"))
                    if (ending == "stop") engine.library.delete(currentId)
                    if (ending != "discard") {
                        CaptureService.startFromVisibleActivity(context, "transition-test-$ending", "in_app")
                        await(engine, "recording")
                    }
                }
            }
        } finally {
            engine.startBeforeAttach = null
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun injectedReadErrorOpensSpanAndRestarts() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            await(engine, "recording")
            awaitAttached(engine)
            val id = engine.status().getString("id")
            Thread.sleep(400)
            engine.injectReadErrorForTest()
            val deadline = System.currentTimeMillis() + 15_000
            while (engine.library.events(id).none { it.optString("e") == "span_open" && it.optString("reason") == "read_error" }
                && System.currentTimeMillis() < deadline) Thread.sleep(50)
            assertTrue(engine.library.events(id).any { it.optString("e") == "span_open" && it.optString("reason") == "read_error" })
            engine.resume()
            await(engine, "recording")
            val note = engine.stop()
            assertTrue(note.getJSONArray("spans").length() > 0)
            engine.library.delete(id)
        } finally {
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun pausedServiceCanResumeFromBackgroundAfterFiveMinutes() {
        assumeTrue(Build.VERSION.SDK_INT == 34 || Build.VERSION.SDK_INT == 36)
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.POST_NOTIFICATIONS}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            await(engine, "recording")
            awaitAttached(engine)
            Thread.sleep(1500)
            engine.pause()
            await(engine, "paused")
            val id = engine.status().getString("id")
            val before = engine.status().getLong("audioMs")
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("input keyevent KEYCODE_HOME").close()
            Thread.sleep(300_000)
            assertEquals("paused", engine.status().optString("state"))
            val notification = context.getSystemService(android.app.NotificationManager::class.java)
                .activeNotifications.first { it.id == 7201 }.notification
            val action = notification.actions.first { it.title.toString() == context.getString(xyz.tinycloud.exo.R.string.capture_resume) }
            action.actionIntent.send()
            await(engine, "recording")
            Log.i("ExoCapture", "T14_BACKGROUND_RESUMED id=$id beforeAudioMs=$before")
            Thread.sleep(12_000)
            val note = engine.stop()
            assertTrue(note.getLong("durationMs") > before + 5_000)
            Log.i("ExoCapture", "T14_BACKGROUND_NOTE id=$id durationMs=${note.getLong("durationMs")}")
        } finally {
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }
}
