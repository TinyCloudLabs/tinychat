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
import org.json.JSONObject
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.junit.Assert.*
import org.junit.Test
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import xyz.tinycloud.exo.capture.core.MAX_DURATION_MS
import xyz.tinycloud.exo.capture.core.RecordingLibrary
import xyz.tinycloud.exo.capture.core.defaultOptions
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import xyz.tinycloud.exo.MainActivity
import kotlin.math.PI
import kotlin.math.sin

@RunWith(AndroidJUnit4::class)
class CaptureInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun awaitState(engine: CaptureEngine, state: String, timeoutMs: Long = 10_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (engine.status().optString("state") != state && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertEquals(state, engine.status().getString("state"))
    }
    private fun captureNotification(): android.app.Notification =
        context.getSystemService(NotificationManager::class.java).activeNotifications
            .firstOrNull { it.id == 7201 }?.notification ?: error("Capture notification missing")
    private fun awaitAction(title: String): android.app.Notification.Action {
        val deadline = System.currentTimeMillis() + 5000
        while (System.currentTimeMillis() < deadline) {
            val action = runCatching { captureNotification().actions.firstOrNull { it.title.toString() == title } }.getOrNull()
            if (action != null) return action
            Thread.sleep(50)
        }
        error("Capture notification action missing: $title")
    }
    private fun grant(permission: String) {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("pm grant ${context.packageName} $permission")
        ).use { it.readBytes() }
    }
    private fun permissionButton(allow: Boolean) {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val suffixes = if (allow) listOf("permission_allow_foreground_only_button", "permission_allow_button")
            else listOf("permission_deny_button", "permission_deny_and_dont_ask_again_button")
        val packages = listOf("com.android.permissioncontroller", "com.google.android.permissioncontroller",
            "com.google.android.packageinstaller", "com.android.packageinstaller")
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            for (pkg in packages) for (suffix in suffixes) {
                val button = device.findObject(By.res(pkg, suffix))
                if (button != null) { button.click(); return }
            }
            Thread.sleep(100)
        }
        error("Runtime permission dialog button missing: allow=$allow")
    }
    private fun awaitNoPendingCommand() {
        val deadline = System.currentTimeMillis() + 5000
        while (LaunchCommandStore(context).pending() != null && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertNull(LaunchCommandStore(context).pending())
    }

    /** Run with RECORD_AUDIO revoked and permission flags reset before instrumentation starts. */
    @Test fun shortcutFirstUsePermissionGrantStartsRecording() {
        assumeTrue("Run this case with RECORD_AUDIO revoked before instrumentation",
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            permissionButton(true)
            awaitState(engine, "recording")
            assertEquals("app_shortcut", engine.status().getString("source"))
            awaitNoPendingCommand()
            Thread.sleep(1200)
            val note = engine.stop()
            assertFalse(note.getBoolean("recovered"))
            engine.library.delete(note.getString("id"))
        } finally {
            if (!engine.status().isNull("id")) engine.stop()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    /** Run with RECORD_AUDIO revoked and permission flags reset before instrumentation starts. */
    @Test fun shortcutDeniedTwiceHoldsCommandAndOffersRecordOnGrant() {
        assumeTrue("Run this case with RECORD_AUDIO revoked before instrumentation",
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
        val engine = CaptureEngine.get(context)
        val firstDenied = CountDownLatch(1)
        val denied = CountDownLatch(2)
        val deniedCount = AtomicInteger(0)
        val granted = CountDownLatch(1)
        val listener = object : CaptureEngine.Listener {
            override fun event(name: String, data: JSONObject) {
                if (name == "presentRecorder" && data.optString("reason") == "permission_denied") {
                    assertTrue(data.isNull("id"))
                    deniedCount.incrementAndGet()
                    firstDenied.countDown()
                    denied.countDown()
                }
                if (name == "presentRecorder" && data.optString("reason") == "permission_granted") granted.countDown()
            }
        }
        engine.addListener(listener)
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            permissionButton(false)
            assertTrue("first denial was not surfaced", firstDenied.await(5, TimeUnit.SECONDS))
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                activity.startActivity(Intent(activity, MainActivity::class.java).setAction(CaptureService.RECORD))
            }
            permissionButton(false)
            assertTrue("denial was not surfaced", denied.await(5, TimeUnit.SECONDS))
            assertEquals("RECORD", LaunchCommandStore(context).pending()?.action)
            assertTrue(MicShortcutRecovery.recordPending(context))
            assertEquals("idle", engine.status().getString("state"))
            Thread.sleep(500)
            assertNull("denial triggered another permission dialog",
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                    .findObject(By.res("com.android.permissioncontroller", "permission_deny_button")))
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
            android.os.ParcelFileDescriptor.AutoCloseInputStream(
                InstrumentationRegistry.getInstrumentation().uiAutomation
                    .executeShellCommand("am start -n ${context.packageName}/.MainActivity")
            ).use { it.readBytes() }
            Thread.sleep(300)
            assertEquals("ordinary resume re-delivered the denial", 2, deniedCount.get())
            MicShortcutRecovery.markSettingsOpened(context)
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressHome()
            grant(Manifest.permission.RECORD_AUDIO)
            android.os.ParcelFileDescriptor.AutoCloseInputStream(
                InstrumentationRegistry.getInstrumentation().uiAutomation
                    .executeShellCommand("am start -n ${context.packageName}/.MainActivity")
            ).use { it.readBytes() }
            assertTrue("grant on return was not surfaced", granted.await(5, TimeUnit.SECONDS))
            assertFalse(MicShortcutRecovery.denied(context))
            assertTrue(MicShortcutRecovery.recordPending(context))
            assertEquals("idle", engine.status().getString("state"))
            MicShortcutRecovery.consumeRecordOffer(context)
            awaitNoPendingCommand()
        } finally { MicShortcutRecovery.dismiss(context); engine.removeListener(listener); activity.finish() }
    }

    @Test fun shortcutCommandAndRecordingSurviveActivityRecreation() {
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val engine = CaptureEngine.get(context)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            awaitState(engine, "recording")
            val id = engine.status().getString("id")
            instrumentation.runOnMainSync { activity.recreate() }
            instrumentation.waitForIdleSync()
            engine.recover() // Plugin load also performs this on WebView recreation.
            assertEquals(id, engine.status().getString("id"))
            assertFalse(engine.library.sidecar(id).exists())
            Thread.sleep(1200)
            val note = engine.stop()
            assertEquals(id, note.getString("id"))
            assertFalse(note.getBoolean("recovered"))
            engine.library.delete(id)
        } finally {
            if (!engine.status().isNull("id")) engine.stop()
            context.stopService(Intent(context, CaptureService::class.java))
            instrumentation.runOnMainSync {
                ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                    .filterIsInstance<MainActivity>().forEach { it.finish() }
            }
        }
    }

    @Test fun failedRecoveryDuringShortcutRecordingNeverCollectsTheLiveSession() {
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val engine = CaptureEngine.get(context)
        val broken = UUID.randomUUID().toString()
        val crashed = RecordingLibrary(engine.library.root, AndroidFileOps())
        crashed.start(broken, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        crashed.openFirstSegment(broken, 0, 1)
        crashed.append(broken, 0, byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x50, 0x40, 0x01, 0x1f, 0xfc.toByte(), 0))
        File(crashed.session(broken), "journal.jsonl").appendText("{invalid complete line}\n")
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            awaitState(engine, "recording")
            val live = engine.status().getString("id")
            repeat(2) { engine.recover() }
            assertTrue(engine.library.session(live).isDirectory)
            assertFalse(engine.library.sidecar(live).exists())
            Thread.sleep(1200)
            assertEquals("recording", engine.status().getString("state"))
            val note = engine.stop()
            assertEquals(live, note.getString("id"))
            assertFalse(note.getBoolean("recovered"))
            assertEquals(1, note.getInt("rev"))
            engine.library.delete(live)
        } finally {
            if (!engine.status().isNull("id")) engine.stop()
            engine.library.delete(broken)
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }

    @Test fun stopJournalFailureReportsNeedsUserAfterInputTeardown() {
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            awaitState(engine, "recording")
            val id = engine.status().getString("id")
            Thread.sleep(1200)
            engine.library.ops.failOnce("stop.journal")
            try { engine.stop(); fail("stop.journal did not fail") } catch (_: java.io.IOException) { }
            assertEquals("needs_user", engine.status().getString("state"))
            assertEquals("write_failed", engine.status().getString("reason"))
            engine.recover()
            assertNotNull(engine.library.read(id))
            try { engine.discard(); fail("Discard deleted a committed note") }
            catch (e: IllegalStateException) { assertEquals("already_committed", e.message) }
            val saved = engine.stop()
            assertEquals(id, saved.getString("id"))
            assertEquals("idle", engine.status().getString("state"))
            engine.library.delete(id)
        } finally {
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }
    @Test fun retryingBlockedResumeDoesNotCloseAnAbsentOmittedSpan() {
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            awaitState(engine, "recording")
            val id = engine.status().getString("id")
            Thread.sleep(1200)
            engine.pause()
            engine.library.ops.failOnce("roll.create")
            try { engine.resume(); fail("resume should fail at roll.create") } catch (_: IllegalStateException) { }
            assertEquals("resume_blocked", engine.status().getString("reason"))
            engine.resume()
            assertEquals("recording", engine.status().getString("state"))
            assertEquals(0, engine.library.events(id).count { it.optString("e") == "span_close" })
            Thread.sleep(1200)
            val note = engine.stop()
            engine.library.delete(note.getString("id"))
        } finally {
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }
    @Test fun slowRecoveryDoesNotBlockMainThreadStatus() {
        grant(Manifest.permission.RECORD_AUDIO)
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        val crashed = RecordingLibrary(engine.library.root, AndroidFileOps())
        val old = UUID.randomUUID().toString()
        crashed.start(old, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        crashed.openFirstSegment(old, 0, 1)
        crashed.append(old, 0, byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x50, 0x40, 0x01, 0x1f, 0xfc.toByte(), 0))
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        engine.library.gate("stage.begin") { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
        val worker = Thread { try { engine.start(null, null, "in_app") } catch (e: Throwable) { failure.set(e) } }
        try {
            worker.start()
            assertTrue("recovery did not reach mux", entered.await(5, TimeUnit.SECONDS))
            val started = System.nanoTime()
            InstrumentationRegistry.getInstrumentation().runOnMainSync { engine.status() }
            assertTrue("status blocked behind recovery", (System.nanoTime() - started) / 1_000_000 < 500)
            release.countDown(); worker.join(10_000)
            assertFalse(worker.isAlive)
            assertNull(failure.get())
            engine.library.clearGate("stage.begin")
            Thread.sleep(1200)
            val note = engine.stop()
            engine.library.delete(note.getString("id"))
            engine.library.delete(old)
        } finally {
            release.countDown(); engine.library.clearGate("stage.begin")
            if (!engine.status().isNull("id")) engine.discard()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }
    @Test fun encodeFinalizeAndProbe44100Hz() {
        val root = File(context.cacheDir, "capture-test-${UUID.randomUUID()}")
        val library = RecordingLibrary(root, AndroidFileOps())
        val id = UUID.randomUUID().toString()
        try {
            library.start(id, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
            library.openFirstSegment(id, 0, 1)
            var packets = 0
            val encoder = AacAdtsEncoder { library.append(id, 0, it); packets++ }
            val samples = 44_100
            val pcm = ByteArray(samples * 2)
            for (i in 0 until samples) {
                val value = (sin(2 * PI * 440 * i / samples) * 5000).toInt().toShort().toInt()
                pcm[i * 2] = value.toByte(); pcm[i * 2 + 1] = (value shr 8).toByte()
            }
            encoder.offer(pcm, pcm.size); encoder.finish()
            assertTrue("AAC packets=$packets for $samples PCM samples",
                packets >= samples / 1024)
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
    @Test fun pauseKeepsBuffersCapturedBeforeTheTap() {
        grant(Manifest.permission.RECORD_AUDIO)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val entered = CountDownLatch(1)
        val releaseWriter = CountDownLatch(1)
        val delivered = AtomicInteger()
        val capture = AudioCapture(context, {
            if (delivered.get() == 0) {
                entered.countDown()
                releaseWriter.await(5, TimeUnit.SECONDS)
            }
            delivered.incrementAndGet()
        }, { _, _ -> }, { _ -> }, { error, detail -> throw AssertionError("$error: $detail") })
        try {
            capture.start()
            assertTrue("writer never received the first buffer", entered.await(3, TimeUnit.SECONDS))
            Thread.sleep(180) // at least one more 50 ms buffer waits in AudioCapture
            val drainFailure = AtomicReference<Throwable?>()
            val draining = Thread { try { capture.drain() } catch (e: Throwable) { drainFailure.set(e) } }
            draining.start()
            Thread.sleep(100) // input stop precedes releasing the blocked writer
            releaseWriter.countDown()
            draining.join(5000)
            assertFalse("capture did not drain", draining.isAlive)
            assertNull("pause drain failed", drainFailure.get())
            assertTrue("pre-pause queued audio was discarded", delivered.get() >= 2)
        } finally {
            releaseWriter.countDown()
            capture.release()
            activity.finish()
        }
    }
    @Test fun pauseCheckpointFailureAutoStops() {
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            val deadline = System.currentTimeMillis() + 5000
            while (engine.status().optString("state") != "recording" && System.currentTimeMillis() < deadline) Thread.sleep(50)
            assertEquals("recording", engine.status().getString("state"))
            val liveId = engine.status().getString("id")
            Thread.sleep(400)
            engine.library.ops.failOnce("seg.sync")
            try { engine.pause(); fail("Pause should reject a failed checkpoint") }
            catch (e: IllegalStateException) { assertEquals("pause_failed", e.message) }
            assertTrue("write failure did not stop capture", engine.status().isNull("id"))
            assertNotNull("durable frames were not committed", engine.library.read(liveId))
            engine.library.delete(liveId)
        } finally {
            if (!engine.status().isNull("id")) engine.stop("write_failed")
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
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
            engine.status().getJSONObject("options").put("transcriber", "mutated-by-caller")
            assertNotEquals("mutated-by-caller", engine.status().getJSONObject("options").getString("transcriber"))
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
    @Test fun writerAppendFailureAutoStopsAndPublishesDurableRevisionOne() {
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        val stopped = AtomicReference<JSONObject?>()
        val listener = object : CaptureEngine.Listener {
            override fun event(name: String, data: JSONObject) { if (name == "autoStopped") stopped.set(data) }
        }
        engine.addListener(listener)
        try {
            awaitState(engine, "recording")
            val id = engine.status().getString("id")
            Thread.sleep(600)
            engine.library.ops.failOnce("seg.write")
            awaitState(engine, "idle", 15_000)
            val eventDeadline = System.currentTimeMillis() + 2000
            while (stopped.get() == null && System.currentTimeMillis() < eventDeadline) Thread.sleep(20)
            val event = stopped.get() ?: error("autoStopped was not emitted after the commit")
            assertEquals("write_failed", event.getString("reason"))
            assertEquals(id, event.getJSONObject("recording").getString("id"))
            val note = engine.library.read(id) ?: error("durable frames were not committed")
            assertTrue(note.getLong("durationMs") > 0)
            assertEquals(1, note.getInt("rev"))
            engine.library.delete(id)
        } finally {
            engine.removeListener(listener)
            if (!engine.status().isNull("id")) engine.stop("write_failed")
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }
    @Test fun secondShortcutKeepsForegroundNotificationAndActionsWork() {
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            awaitState(engine, "recording")
            val id = engine.status().getString("id")
            awaitAction(context.getString(xyz.tinycloud.exo.R.string.capture_pause))
            assertEquals(2, captureNotification().actions.size)
            context.startActivity(Intent(context, MainActivity::class.java)
                .setAction(CaptureService.RECORD)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            Thread.sleep(300)
            assertEquals(id, engine.status().getString("id"))
            val pause = awaitAction(context.getString(xyz.tinycloud.exo.R.string.capture_pause))
            pause.actionIntent.send()
            awaitState(engine, "paused")
            val resume = awaitAction(context.getString(xyz.tinycloud.exo.R.string.capture_resume))
            val stop = awaitAction(context.getString(xyz.tinycloud.exo.R.string.capture_stop))
            resume.actionIntent.send()
            awaitState(engine, "recording")
            // Stop remains valid while Android is still posting the new epoch's notification.
            stop.actionIntent.send()
            awaitState(engine, "idle", 15_000)
            assertNotNull(engine.library.read(id))
            engine.library.delete(id)
        } finally {
            if (!engine.status().isNull("id")) engine.stop()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
    }
    @Test fun staleForegroundNotificationStopDoesNotKillTheProcess() {
        assumeTrue("Foreground service timeout starts on Android 8", Build.VERSION.SDK_INT >= 26)
        grant(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) grant(Manifest.permission.POST_NOTIFICATIONS)
        val activity = InstrumentationRegistry.getInstrumentation().startActivitySync(Intent(context, MainActivity::class.java)
            .setAction(CaptureService.RECORD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine = CaptureEngine.get(context)
        try {
            awaitState(engine, "recording")
            val id = engine.status().getString("id")
            engine.stop()
            context.stopService(Intent(context, CaptureService::class.java))
            val stale = Intent(context, CaptureService::class.java).setAction(CaptureService.ACTION_STOP).putExtra("id", id)
            ContextCompat.startForegroundService(context, stale)
            Thread.sleep(6_000) // Android's foreground-service deadline would kill the process.
            assertEquals("idle", engine.status().getString("state"))
            engine.library.delete(id)
        } finally {
            if (!engine.status().isNull("id")) engine.stop()
            context.stopService(Intent(context, CaptureService::class.java))
            activity.finish()
        }
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
