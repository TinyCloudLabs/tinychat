package xyz.tinycloud.exo

/** Compile-time and JVM-test probe for Kotlin sources in the Android app module. */
internal object KotlinProbe {
    fun echo(value: String): String = value
}
