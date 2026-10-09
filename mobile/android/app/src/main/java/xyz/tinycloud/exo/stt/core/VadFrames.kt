package xyz.tinycloud.exo.stt.core

/** Sherpa 1.13.8 makes one speech decision per acceptWaveform call, even for multiple windows. */
internal object VadFrames {
    const val SIZE = 512 // Silero's 16 kHz window, matching the iOS and Python benchmarks.

    /** Small seam available to the debug benchmark and future transcription queue. */
    interface Source<Segment> {
        fun acceptWaveform(samples: FloatArray)
        fun empty(): Boolean
        fun front(): Segment
        fun pop()
        fun flush()
    }

    /** Drive VAD and decode each segment before accepting more audio. */
    fun <Segment, Decoded> decode(samples: FloatArray, source: Source<Segment>,
                                  decodeSegment: (Segment) -> Decoded,
                                  onVadCall: ((() -> Unit) -> Unit) = { it() }): List<Decoded> {
        val decoded = mutableListOf<Decoded>()
        fun drain() {
            while (!source.empty()) {
                val segment = source.front()
                source.pop()
                decoded.add(decodeSegment(segment))
            }
        }
        for (start in samples.indices step SIZE) {
            val frame = samples.copyOfRange(start, minOf(start + SIZE, samples.size))
            onVadCall { source.acceptWaveform(frame) }
            drain()
        }
        onVadCall(source::flush)
        drain()
        return decoded
    }
}
