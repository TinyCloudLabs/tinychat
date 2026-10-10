package xyz.tinycloud.exo.stt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BenchmarkOptionsTest {
    @Test fun acceptsFocusedAmiRun() {
        val options = Benchmark.Options(threads = listOf(4), only = "ami-es2004a-10m")
        assertEquals("ami-es2004a-10m", options.only)
    }

    @Test fun rejectsUnknownFixture() {
        assertThrows(IllegalArgumentException::class.java) {
            Benchmark.Options(threads = listOf(4), only = "unknown")
        }
    }
}
