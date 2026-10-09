package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sin

class StreamResamplerTest {
    private fun resampleWhole(input: FloatArray, sourceRate: Int, targetRate: Int): FloatArray {
        val out = mutableListOf<Float>()
        StreamResampler(sourceRate, targetRate).push(input, out::add)
        return out.toFloatArray()
    }

    @Test fun passesSamplesThroughUnchangedWhenRatesMatch() {
        val input = FloatArray(1000) { sin(it * 0.1).toFloat() }
        assertEquals(input.toList(), resampleWhole(input, 16_000, 16_000).toList())
    }

    @Test fun matchesAOneShotResampleWhenFedInManySmallChunks() {
        val sourceRate = 44_100
        val targetRate = 16_000
        val input = FloatArray(10_000) { sin(it * 0.05).toFloat() }
        val reference = resampleWhole(input, sourceRate, targetRate)

        val streamed = mutableListOf<Float>()
        val resampler = StreamResampler(sourceRate, targetRate)
        var offset = 0
        val chunkSizes = intArrayOf(1, 3, 97, 256, 17)
        var i = 0
        while (offset < input.size) {
            val take = minOf(chunkSizes[i % chunkSizes.size], input.size - offset)
            resampler.push(input.copyOfRange(offset, offset + take), streamed::add)
            offset += take
            i++
        }

        assertEquals(reference.size, streamed.size)
        assertEquals(reference.toList(), streamed)
    }

    @Test fun upsamplingAlsoStaysContinuousAcrossChunkBoundaries() {
        val input = FloatArray(5_000) { sin(it * 0.02).toFloat() }
        val reference = resampleWhole(input, 8_000, 16_000)

        val streamed = mutableListOf<Float>()
        val resampler = StreamResampler(8_000, 16_000)
        var offset = 0
        while (offset < input.size) {
            val take = minOf(13, input.size - offset)
            resampler.push(input.copyOfRange(offset, offset + take), streamed::add)
            offset += take
        }

        assertEquals(reference.toList(), streamed)
    }

    @Test fun emptyPushesProduceNoOutputAndDoNotDisruptLaterContinuity() {
        val input = FloatArray(2_000) { it.toFloat() }
        val reference = resampleWhole(input, 48_000, 16_000)

        val streamed = mutableListOf<Float>()
        val resampler = StreamResampler(48_000, 16_000)
        resampler.push(FloatArray(0), streamed::add)
        resampler.push(input.copyOfRange(0, 1000), streamed::add)
        resampler.push(FloatArray(0), streamed::add)
        resampler.push(input.copyOfRange(1000, 2000), streamed::add)

        assertEquals(reference.toList(), streamed)
    }

    @Test fun threeHourSyntheticSourceStreamsWithBoundedPerCallWork() {
        // Proves the resampler never needs more than one small chunk's worth of state at a time:
        // the same property AudioDecoder relies on to avoid materializing a whole note (TC-836).
        val sourceRate = 44_100
        val targetRate = 16_000
        val totalSamples = 3L * 3600 * sourceRate
        val resampler = StreamResampler(sourceRate, targetRate)
        var emitted = 0L
        val chunkSize = 4096
        val chunk = FloatArray(chunkSize)
        var remaining = totalSamples
        while (remaining > 0) {
            val take = minOf(chunkSize.toLong(), remaining).toInt()
            resampler.push(if (take == chunkSize) chunk else chunk.copyOf(take)) { emitted++ }
            remaining -= take
        }
        val expected = (totalSamples * targetRate) / sourceRate
        assertTrue(kotlin.math.abs(emitted - expected) <= 1)
    }
}
