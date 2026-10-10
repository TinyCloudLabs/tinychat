package xyz.tinycloud.exo.stt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Guards the native boundary because JVM tests cannot construct the benchmark's ONNX recognizer. */
class BenchmarkVadBoundaryTest {
    @Test fun benchmarkCannotBypassTheFramedVadSource() {
        val relative = "src/main/java/xyz/tinycloud/exo/stt/Benchmark.kt"
        val source = sequenceOf(File(relative), File("app/$relative"))
            .firstOrNull { it.isFile }?.readText() ?: error("Missing Benchmark.kt source")

        assertTrue("Benchmark must use the guarded native VAD adapter", source.contains("SherpaVadSource("))
        val waveformReceivers = Regex("""\b(\w+)\.acceptWaveform\s*\(""")
            .findAll(source).map { it.groupValues[1] }.toList()
        assertEquals("Only the ASR stream may receive waveform directly", listOf("stream"), waveformReceivers)
        assertTrue("Benchmark must run VAD and decoding through core", source.contains("VadFrames.decode(samples, source,"))
        assertTrue("Benchmark must not own the raw native VAD", !Regex("""\bVad\s*\(""").containsMatchIn(source))
    }
}
