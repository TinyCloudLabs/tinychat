package xyz.tinycloud.exo.stt.core

import com.k2fsa.sherpa.onnx.SpeechSegment
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig

/** Owns the native VAD so callers cannot feed it without the frame-size guard. */
internal class SherpaVadSource(config: VadModelConfig) : VadFrames.Source<SpeechSegment>, AutoCloseable {
    private val vad = Vad(config = config)

    override fun acceptWaveform(samples: FloatArray) {
        require(samples.size <= VadFrames.SIZE) { "Silero VAD accepts at most ${VadFrames.SIZE} samples per call" }
        vad.acceptWaveform(samples)
    }

    override fun empty() = vad.empty()
    override fun front() = vad.front()
    override fun pop() = vad.pop()
    override fun flush() = vad.flush()
    override fun close() = vad.release()
}
