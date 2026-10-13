package xyz.tinycloud.exo.capture.core

import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/** Capture format v1's byte-stable JSON representation. */
object CanonicalJson {
    fun line(value: JSONObject): ByteArray = (encode(value) + "\n").toByteArray(StandardCharsets.UTF_8)

    fun encode(value: Any?): String = buildString { appendValue(this, value) }

    private fun appendValue(out: StringBuilder, value: Any?) {
        when (value) {
            null, JSONObject.NULL -> out.append("null")
            is JSONObject -> {
                out.append('{')
                val keys = value.keys().asSequence().toList().sorted()
                keys.forEachIndexed { index, key ->
                    if (index != 0) out.append(',')
                    appendString(out, key)
                    out.append(':')
                    appendValue(out, value.get(key))
                }
                out.append('}')
            }
            is JSONArray -> {
                out.append('[')
                for (index in 0 until value.length()) {
                    if (index != 0) out.append(',')
                    appendValue(out, value.get(index))
                }
                out.append(']')
            }
            is String -> appendString(out, value)
            is Boolean -> out.append(if (value) "true" else "false")
            is Byte, is Short, is Int, is Long -> out.append(value.toString())
            else -> throw IllegalArgumentException("Non-canonical JSON value: ${value.javaClass.name}")
        }
    }

    private fun appendString(out: StringBuilder, value: String) {
        out.append('"')
        var index = 0
        while (index < value.length) {
            val c = value[index]
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\b' -> out.append("\\b")
                '\t' -> out.append("\\t")
                '\n' -> out.append("\\n")
                '\u000c' -> out.append("\\f")
                '\r' -> out.append("\\r")
                else -> when {
                    c < ' ' -> out.append("\\u00").append(c.code.toString(16).padStart(2, '0'))
                    Character.isHighSurrogate(c) -> {
                        require(index + 1 < value.length && Character.isLowSurrogate(value[index + 1])) { "Invalid surrogate" }
                        out.append(c).append(value[++index])
                    }
                    Character.isLowSurrogate(c) -> throw IllegalArgumentException("Invalid surrogate")
                    else -> out.append(c)
                }
            }
            index++
        }
        out.append('"')
    }
}
