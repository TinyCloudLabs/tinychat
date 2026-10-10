package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WindowAccumulatorTest {
    @Test fun emitsExactlyOneWindowForExactlyOneWindowsWorthOfInput() {
        val windows = mutableListOf<FloatArray>()
        val accumulator = WindowAccumulator(4) { windows.add(it) }
        accumulator.push(floatArrayOf(1f, 2f, 3f, 4f))
        assertEquals(listOf(listOf(1f, 2f, 3f, 4f)), windows.map { it.toList() })
    }

    @Test fun assemblesWindowsAcrossManySmallPushesRegardlessOfPushGranularity() {
        // Mirrors MediaCodec output buffers arriving at sizes unrelated to the VAD window size.
        val windows = mutableListOf<FloatArray>()
        val accumulator = WindowAccumulator(512) { windows.add(it) }
        val input = FloatArray(512 * 3 + 100) { it.toFloat() }
        val pushSizes = intArrayOf(37, 1, 900, 200)
        var offset = 0
        var i = 0
        while (offset < input.size) {
            val take = minOf(pushSizes[i % pushSizes.size], input.size - offset)
            accumulator.push(input.copyOfRange(offset, offset + take))
            offset += take
            i++
        }
        accumulator.finish()
        assertEquals(listOf(512, 512, 512, 100), windows.map { it.size })
        assertEquals(input.toList(), windows.flatMap { it.toList() })
    }

    @Test fun finishFlushesAShorterFinalWindowExactlyOnce() {
        val windows = mutableListOf<FloatArray>()
        val accumulator = WindowAccumulator(10) { windows.add(it) }
        accumulator.push(floatArrayOf(1f, 2f, 3f))
        accumulator.finish()
        accumulator.finish()
        assertEquals(1, windows.size)
        assertEquals(listOf(1f, 2f, 3f), windows[0].toList())
    }

    @Test fun finishIsANoOpWhenNothingIsBuffered() {
        val windows = mutableListOf<FloatArray>()
        val accumulator = WindowAccumulator(10) { windows.add(it) }
        accumulator.push(floatArrayOf(1f, 2f, 3f, 4f, 5f, 6f, 7f, 8f, 9f, 10f))
        accumulator.finish()
        assertEquals(1, windows.size)
    }

    @Test fun pushOneMatchesPushForASingleSample() {
        val windows = mutableListOf<FloatArray>()
        val accumulator = WindowAccumulator(2) { windows.add(it) }
        accumulator.pushOne(1f)
        accumulator.pushOne(2f)
        accumulator.pushOne(3f)
        accumulator.finish()
        assertEquals(listOf(listOf(1f, 2f), listOf(3f)), windows.map { it.toList() })
    }

    /** A 3-hour note's worth of samples, streamed through in small codec-sized pushes, without ever
     * materializing the whole note: proves the design that fixed TC-836's whole-file-decode OOM. */
    @Test fun staysCorrectAcrossAThreeHourSyntheticNoteStreamedInSmallChunks() {
        val sampleRate = 16_000L
        val totalSamples = 3L * 3600 * sampleRate // 172,800,000 samples
        val windowSize = 512
        var windowCount = 0L
        var totalEmitted = 0L
        var sawOversizedWindow = false
        val accumulator = WindowAccumulator(windowSize) { window ->
            windowCount++
            totalEmitted += window.size
            if (window.size > windowSize) sawOversizedWindow = true
        }

        val chunkSize = 4096
        var remaining = totalSamples
        val chunk = FloatArray(chunkSize) // one small, reused buffer: the test itself stays bounded too
        while (remaining > 0) {
            val take = minOf(chunkSize.toLong(), remaining).toInt()
            accumulator.push(if (take == chunkSize) chunk else chunk.copyOf(take))
            remaining -= take
        }
        accumulator.finish()

        assertEquals(totalSamples, totalEmitted)
        assertTrue("no window may exceed windowSize", !sawOversizedWindow)
        assertEquals(totalSamples / windowSize, windowCount) // exact: totalSamples is windowSize-aligned
    }
}
