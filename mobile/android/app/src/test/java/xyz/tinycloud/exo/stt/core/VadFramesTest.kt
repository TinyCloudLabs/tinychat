package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.ArrayDeque

class VadFramesTest {
    private class FakeVad : VadFrames.Source<Int> {
        val frames = mutableListOf<FloatArray>()
        val events = mutableListOf<String>()
        private val segments = ArrayDeque<Int>()
        var flushes = 0

        override fun acceptWaveform(samples: FloatArray) {
            frames.add(samples.copyOf())
            events.add("accept:${samples.size}")
            if (frames.size == 2) segments.addLast(7)
        }
        override fun empty() = segments.isEmpty()
        override fun front() = segments.first
        override fun pop() { segments.removeFirst() }
        override fun flush() {
            flushes++
            events.add("flush")
            segments.addLast(9)
        }
    }

    @Test fun processesEverySileroWindowAndDrainsBeforeNextCall() {
        val input = FloatArray(512 * 2 + 17) { it.toFloat() }
        val vad = FakeVad()
        val output = mutableListOf<Int>()
        var timedCalls = 0
        VadFrames.process(input, vad, onSegment = { output.add(it); vad.events.add("segment:$it") },
            onVadCall = { call -> timedCalls++; call() })

        val frames = vad.frames
        assertEquals(listOf(512, 512, 17), frames.map { it.size })
        assertTrue(frames.all { it.size <= 512 })
        assertArrayEquals(input, frames.flatMap { it.asList() }.toFloatArray(), 0f)
        assertEquals(listOf("accept:512", "accept:512", "segment:7", "accept:17", "flush", "segment:9"), vad.events)
        assertEquals(listOf(7, 9), output)
        assertEquals(1, vad.flushes)
        assertEquals(4, timedCalls)
    }

    @Test fun flushesEmptyInputAndDrainsItsFinalSegment() {
        val vad = FakeVad()
        val output = mutableListOf<Int>()
        VadFrames.process(floatArrayOf(), vad, output::add)
        assertTrue(vad.frames.isEmpty())
        assertEquals(listOf(9), output)
        assertEquals(1, vad.flushes)
    }
}
