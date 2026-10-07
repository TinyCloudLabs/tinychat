package xyz.tinycloud.exo.stt.core

internal data class TimedWord(val start: Double, val end: Double, val text: String, val speaker: String? = null)
internal data class SpeakerTurn(val start: Double, val end: Double, val speaker: String)

internal object TokenWordAlignment {
    fun align(tokens: Array<String>, timestamps: FloatArray, durations: FloatArray, origin: Double): List<TimedWord> {
        require(tokens.size == timestamps.size && tokens.size == durations.size) { "Sherpa token timing count mismatch" }
        val words = mutableListOf<TimedWord>()
        var text = ""
        var start = 0.0
        var end = 0.0
        for (index in tokens.indices) {
            val token = tokens[index]
            val boundary = token.startsWith(' ') || token.startsWith('▁')
            val piece = token.replace('▁', ' ').trim()
            val tokenStart = origin + timestamps[index].toDouble()
            val tokenEnd = tokenStart + durations[index]
            require(tokenStart.isFinite() && tokenEnd.isFinite() && tokenEnd >= tokenStart) { "Invalid Sherpa token timing" }
            if (boundary && text.isNotEmpty()) {
                words.add(TimedWord(start, end, text))
                text = ""
            }
            if (piece.isEmpty()) continue
            if (text.isEmpty()) { start = tokenStart; end = tokenEnd }
            text += piece
            end = maxOf(end, tokenEnd)
        }
        if (text.isNotEmpty()) words.add(TimedWord(start, end, text))
        return words
    }
}

internal object SpeakerAttribution {
    fun assign(words: List<TimedWord>, turns: List<SpeakerTurn>): List<TimedWord> {
        val ordered = turns.sortedWith(compareBy<SpeakerTurn> { it.start }.thenBy { it.speaker })
        var previous: String? = null
        return words.map { word ->
            val covering = ordered.firstOrNull { it.start <= word.start && word.start < it.end }
            val nearest = ordered.minByOrNull { maxOf(it.start - word.start, word.start - it.end, 0.0) }
            val distance = nearest?.let { maxOf(it.start - word.start, word.start - it.end, 0.0) } ?: Double.POSITIVE_INFINITY
            val speaker = covering?.speaker ?: if (distance <= 0.5) nearest?.speaker else previous
            previous = speaker
            word.copy(speaker = speaker)
        }
    }
}
