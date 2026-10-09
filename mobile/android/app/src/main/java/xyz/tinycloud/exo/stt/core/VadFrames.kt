package xyz.tinycloud.exo.stt.core

/** Sherpa 1.13.8 makes one speech decision per acceptWaveform call, even for multiple windows. */
internal object VadFrames {
    const val SIZE = 512 // Silero's 16 kHz window, matching the iOS and Python benchmarks.

    fun feed(samples: FloatArray, accept: (FloatArray) -> Unit) {
        for (start in samples.indices step SIZE) {
            accept(samples.copyOfRange(start, minOf(start + SIZE, samples.size)))
        }
    }
}
