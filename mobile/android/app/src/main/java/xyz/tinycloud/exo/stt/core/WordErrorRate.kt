package xyz.tinycloud.exo.stt.core

import java.text.Normalizer
import java.util.Locale

internal data class Wer(val errors: Int, val referenceWords: Int, val hypothesisWords: Int) {
    val rate: Double get() = errors.toDouble() / referenceWords
}

internal object WordErrorRate {
    fun tokens(text: String): List<String> = Normalizer.normalize(text, Normalizer.Form.NFKC)
        .lowercase(Locale.ROOT)
        .map { if (it.isLetterOrDigit() || it.isWhitespace()) it else ' ' }
        .joinToString("")
        .split(Regex("\\s+"))
        .filter(String::isNotEmpty)

    fun score(reference: String, hypothesis: String): Wer {
        val expected = tokens(reference)
        require(expected.isNotEmpty()) { "Empty STT reference" }
        val actual = tokens(hypothesis)
        var row = IntArray(actual.size + 1) { it }
        for ((index, word) in expected.withIndex()) {
            val next = IntArray(actual.size + 1)
            next[0] = index + 1
            for (j in actual.indices) {
                next[j + 1] = minOf(next[j] + 1, row[j + 1] + 1,
                    row[j] + if (word == actual[j]) 0 else 1)
            }
            row = next
        }
        return Wer(row.last(), expected.size, actual.size)
    }
}
