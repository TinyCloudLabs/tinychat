package xyz.tinycloud.exo.stt.core

/** Sherpa 1.13.8 makes one speech decision per acceptWaveform call, even for multiple windows. */
internal object VadFrames {
    const val SIZE = 512 // Silero's 16 kHz window, matching the iOS and Python benchmarks.

    /** Small seam shared by the debug benchmark and the production transcription queue. */
    interface Source<Segment> {
        fun acceptWaveform(samples: FloatArray)
        fun empty(): Boolean
        fun front(): Segment
        fun pop()
        fun flush()
    }

    /** Drain after every Silero window and once more after flush, preserving short pauses. */
    fun <Segment> process(samples: FloatArray, source: Source<Segment>, onSegment: (Segment) -> Unit,
                         onVadCall: ((() -> Unit) -> Unit) = { it() }) {
        fun drain() {
            while (!source.empty()) {
                val segment = source.front()
                source.pop()
                onSegment(segment)
            }
        }
        for (start in samples.indices step SIZE) {
            val frame = samples.copyOfRange(start, minOf(start + SIZE, samples.size))
            onVadCall { source.acceptWaveform(frame) }
            drain()
        }
        onVadCall(source::flush)
        drain()
    }
}
