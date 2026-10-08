package xyz.tinycloud.exo.stt

/** One file inside a downloadable model. */
data class ModelFile(val name: String, val url: String, val bytes: Long, val sha256: String)

/**
 * Every model this build can actually download. `parakeet-tdt-110m-en-int8` and `diarization`
 * are reported by `status()` for shape parity with the TS contract but have no entry here: the
 * small pack's release asset is a `.tar.bz2` and this slice does not implement on-device archive
 * extraction (TC-836 report, deviations). Revision `2bda32ec70b097a55adaa07d9a7173915b43cc78`
 * and every sha256 are pinned by T7's `mobile/stt-fixtures.lock`.
 */
object ModelManifest {
    const val PARAKEET_FULL = "parakeet-tdt-0.6b-v3-int8"
    const val PARAKEET_SMALL = "parakeet-tdt-110m-en-int8"
    const val SILERO_VAD = "silero-vad"
    const val DIARIZATION = "diarization"
    val ALL_IDS = listOf(PARAKEET_FULL, PARAKEET_SMALL, SILERO_VAD, DIARIZATION)

    private const val PARAKEET_BASE =
        "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78"

    val DOWNLOADABLE: Map<String, List<ModelFile>> = mapOf(
        PARAKEET_FULL to listOf(
            ModelFile("encoder.int8.onnx", "$PARAKEET_BASE/encoder.int8.onnx", 652_184_281L,
                "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
            ModelFile("decoder.int8.onnx", "$PARAKEET_BASE/decoder.int8.onnx", 11_845_275L,
                "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
            ModelFile("joiner.int8.onnx", "$PARAKEET_BASE/joiner.int8.onnx", 6_355_277L,
                "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
            ModelFile("tokens.txt", "$PARAKEET_BASE/tokens.txt", 93_939L,
                "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
        ),
        SILERO_VAD to listOf(
            ModelFile("silero_vad.onnx", "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
                643_854L, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"),
        ),
    )

    fun totalBytes(id: String): Long = when (id) {
        PARAKEET_FULL -> 670_478_772L
        PARAKEET_SMALL -> 136_490_421L
        SILERO_VAD -> 643_854L
        DIARIZATION -> 31_137_484L
        else -> 0L
    }

    /** The primary ASR model for a RAM tier (plan §2.9; T17 checks the threshold on a real device). */
    fun primaryModel(totalRamBytes: Long): String = if (totalRamBytes >= 6_000_000_000L) PARAKEET_FULL else PARAKEET_SMALL
}
