package xyz.tinycloud.exo

import kotlin.test.Test
import kotlin.test.assertEquals

class KotlinProbeTest {
    @Test
    fun kotlinSourceIsAvailableToJvmTests() {
        assertEquals("Kotlin is ready", KotlinProbe.echo("Kotlin is ready"))
    }
}
