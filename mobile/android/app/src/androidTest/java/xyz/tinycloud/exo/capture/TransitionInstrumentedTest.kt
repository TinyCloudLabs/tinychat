package xyz.tinycloud.exo.capture

import android.Manifest
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.SystemClock
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

    @Test fun committedDurationTracksLiveRecordingTime() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            CaptureService.startFromVisibleActivity(context, "duration-test", "in_app")
            await(engine, "recording")
            awaitAttached(engine)
            val checkpointDeadline = SystemClock.elapsedRealtime() + 5_000
            while (engine.status().getLong("audioMs") == 0L &&
                SystemClock.elapsedRealtime() < checkpointDeadline) Thread.sleep(50)
            val beforeAudioMs = engine.status().getLong("audioMs")
            assertTrue("recording never reached a durable audio checkpoint", beforeAudioMs > 0)
            val from = SystemClock.elapsedRealtime()
            Thread.sleep(8_000)
            val until = SystemClock.elapsedRealtime()
            val note = engine.stop()
            val capturedMs = until - from
            val addedAudioMs = note.getLong("durationMs") - beforeAudioMs
            val difference = kotlin.math.abs(addedAudioMs - capturedMs)
            assertTrue("audio added $addedAudioMs ms vs live $capturedMs ms",
                difference <= capturedMs / 20 + 250)
            engine.library.delete(note.getString("id"))
        } finally {
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun missingSavedInputUsesSystemRouteAtStartAndAfterRebuild() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val prefs = context.getSharedPreferences("exo.capture.inputs", android.content.Context.MODE_PRIVATE)
        val previous = prefs.getString("selectedId", null)
        val missing = "999:Disconnected headset"
        check(prefs.edit().putString("selectedId", missing).commit())
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            try { engine.selectInput("999:Another absent input"); fail("Selection must reject an absent device") }
            catch (expected: IllegalArgumentException) { assertEquals("input_unavailable", expected.message) }
            CaptureService.startFromVisibleActivity(context, "missing-input-test", "in_app")
            await(engine, "recording")
            awaitAttached(engine)
            assertEquals(missing, engine.listInputs().getString("selectedId"))
            assertNotEquals(missing, engine.status().getString("activeId"))
            assertEquals(engine.status().getString("activeId"), engine.status().getJSONObject("input").getString("id"))
            engine.rebuildForTest() // Mirrors the selected headset disappearing during capture.
            await(engine, "recording")
            awaitAttached(engine)
            assertEquals(missing, engine.listInputs().getString("selectedId"))
            assertNotEquals(missing, engine.status().getString("activeId"))
            val active = engine.status().getString("activeId")
            assertEquals(active, engine.library.events(engine.status().getString("id"))
                .last { it.optString("e") == "input" }.getString("id"))
            val note = engine.stop()
            assertEquals(active, note.getJSONObject("input").getString("id"))
            engine.library.delete(note.getString("id"))
        } finally {
            if (!engine.status().isNull("id")) engine.discard()
            check(prefs.edit().putString("selectedId", previous).commit())
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun failedAutomaticRetryStaysInterruptedWithoutAlertOrBlockedJournal() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        val entered = CountDownLatch(1)
        try {
            await(engine, "recording"); awaitAttached(engine)
            val id = engine.status().getString("id")
            Thread.sleep(500)
            engine.startBeforeAttach = { entered.countDown(); throw IllegalStateException("mic_unavailable") }
            engine.injectReadErrorForTest()
            assertTrue("automatic retry never attempted", entered.await(10, TimeUnit.SECONDS))
            val failureDeadline = SystemClock.elapsedRealtime() + 5_000
            while (engine.retryFailureForTest() == null && SystemClock.elapsedRealtime() < failureDeadline) Thread.sleep(50)
            assertEquals("mic_unavailable", engine.retryFailureForTest())
            assertEquals("interrupted", engine.status().getString("state"))
            assertEquals("interrupted", engine.status().getString("availability"))
            assertFalse(engine.library.events(id).any { it.optString("e") == "avail" && it.optString("value") == "blocked" })
            assertFalse(context.getSystemService(android.app.NotificationManager::class.java)
                .activeNotifications.any { it.id == 7202 })
            engine.exhaustRetryForTest()
            await(engine, "needs_user")
            val blocked = engine.library.events(id).count { it.optString("e") == "avail" && it.optString("value") == "blocked" }
            assertEquals(1, blocked)
            val manager = context.getSystemService(android.app.NotificationManager::class.java)
            val alertDeadline = SystemClock.elapsedRealtime() + 5_000
            while (manager.activeNotifications.none { it.id == 7202 } &&
                SystemClock.elapsedRealtime() < alertDeadline) Thread.sleep(50)
            assertTrue("retry exhaustion did not post its alert", manager.activeNotifications.any { it.id == 7202 })
            engine.exhaustRetryForTest()
            assertEquals(blocked, engine.library.events(id).count { it.optString("e") == "avail" && it.optString("value") == "blocked" })
            engine.startBeforeAttach = null
            engine.resume()
            await(engine, "recording")
            val note = engine.stop()
            engine.library.delete(note.getString("id"))
        } finally {
            engine.startBeforeAttach = null
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun automaticRestartInvalidatedByPauseAndStaleResume() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            await(engine, "recording"); awaitAttached(engine)
            val id = engine.status().getString("id")
            val stale = CaptureNotifications.action(context, CaptureService.ACTION_RESUME, 87, engine.status())
            Thread.sleep(500)
            engine.startBeforeAttach = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
            engine.injectReadErrorForTest()
            assertTrue("automatic restart never reached attach gate", entered.await(10, TimeUnit.SECONDS))
            val before = engine.library.events(id).count { it.optString("e") == "segment" }
            engine.pause()
            release.countDown()
            Thread.sleep(500)
            stale.send()
            Thread.sleep(300)
            assertEquals("paused", engine.status().getString("state"))
            assertEquals(before, engine.library.events(id).count { it.optString("e") == "segment" })
            assertTrue(context.getSystemService(AudioManager::class.java).activeRecordingConfigurations
                .none { it.clientAudioSource == android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION })
            val note = engine.stop()
            engine.library.delete(note.getString("id"))
        } finally {
            release.countDown(); engine.startBeforeAttach = null
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun stopDuringBackoffCannotRestartTheMic() {
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            await(engine, "recording"); awaitAttached(engine)
            Thread.sleep(500)
            engine.injectReadErrorForTest()
            val note = engine.stop()
            Thread.sleep(1200)
            assertTrue(engine.status().isNull("id"))
            assertTrue(context.getSystemService(AudioManager::class.java).activeRecordingConfigurations
                .none { it.clientAudioSource == android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION })
            engine.library.delete(note.getString("id"))
        } finally {
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
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
                val segmentsBefore = engine.library.events(currentId).count { it.optString("e") == "segment" }
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
                if (ending == "pause") assertEquals("stale Resume opened a segment", segmentsBefore,
                    engine.library.events(currentId).count { it.optString("e") == "segment" })
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
