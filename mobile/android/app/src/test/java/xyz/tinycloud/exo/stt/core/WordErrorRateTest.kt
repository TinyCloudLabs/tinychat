package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Test

class WordErrorRateTest {
    @Test fun normalizesLikeFixtureScorer() {
        val result = WordErrorRate.score("Hello, WORLD! Café", "hello world cafe")
        assertEquals(1, result.errors)
        assertEquals(3, result.referenceWords)
        assertEquals(3, result.hypothesisWords)
    }

    @Test fun countsEmptyHypothesisAsAllDeletions() {
        assertEquals(2, WordErrorRate.score("one two", "").errors)
    }
}
