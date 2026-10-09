package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class VadFramesTest {
    @Test fun feedsEachSileroWindowExactlyOnceIncludingShortTail() {
        val input = FloatArray(VadFrames.SIZE * 2 + 17) { it.toFloat() }
        val frames = mutableListOf<FloatArray>()
        VadFrames.feed(input, frames::add)
        assertEquals(listOf(512, 512, 17), frames.map { it.size })
        assertArrayEquals(input, frames.flatMap { it.asList() }.toFloatArray(), 0f)
    }
}
