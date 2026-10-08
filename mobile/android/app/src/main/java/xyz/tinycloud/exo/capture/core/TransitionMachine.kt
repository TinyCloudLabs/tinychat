package xyz.tinycloud.exo.capture.core

/** Pure transition policy. gen owns an input attempt; epoch owns user actions. */
class TransitionMachine {
    enum class Intent { RECORDING, PAUSED, STOPPED }
    enum class Availability { AVAILABLE, INTERRUPTED, BLOCKED }
    enum class Event { INTERRUPTION_BEGAN, INTERRUPTION_ENDED, BACKOFF_EXHAUSTED, ROUTE_CHANGE,
        MEDIA_RESET, STALL, SILENCED, PAUSE, RESUME, STOP, DISCARD, APP_ACTIVE }

    var intent = Intent.STOPPED; private set
    var availability = Availability.AVAILABLE; private set
    var gen = 0L; private set
    var epoch = 0L; private set
    var silenced = false; private set

    fun start(): Long {
        check(intent == Intent.STOPPED)
        intent = Intent.RECORDING
        availability = Availability.AVAILABLE
        return ++gen
    }

    fun accepts(attempt: Long) = intent == Intent.RECORDING && gen == attempt

    /** Returns whether a fresh input attempt is needed. */
    fun send(event: Event): Boolean {
        when (intent) {
            Intent.STOPPED -> return false
            Intent.PAUSED -> when (event) {
                Event.RESUME -> { intent = Intent.RECORDING; availability = Availability.AVAILABLE; ++gen; return true }
                Event.STOP, Event.DISCARD -> { intent = Intent.STOPPED; ++gen; ++epoch }
                else -> Unit
            }
            Intent.RECORDING -> when (event) {
                Event.PAUSE -> { intent = Intent.PAUSED; availability = Availability.AVAILABLE; silenced = false; ++gen; ++epoch }
                Event.STOP, Event.DISCARD -> { intent = Intent.STOPPED; ++gen; ++epoch }
                Event.INTERRUPTION_BEGAN, Event.MEDIA_RESET, Event.STALL -> {
                    availability = Availability.INTERRUPTED; silenced = false; ++gen
                }
                Event.INTERRUPTION_ENDED -> if (availability == Availability.INTERRUPTED) { ++gen; return true }
                Event.BACKOFF_EXHAUSTED -> availability = Availability.BLOCKED
                Event.ROUTE_CHANGE -> { ++gen; return true }
                Event.SILENCED -> silenced = true
                Event.RESUME, Event.APP_ACTIVE -> if (availability != Availability.AVAILABLE) { ++gen; return true }
            }
        }
        return false
    }

    fun acquired(attempt: Long): Boolean {
        if (!accepts(attempt)) return false
        availability = Availability.AVAILABLE
        silenced = false
        ++epoch
        return true
    }

    fun failed(attempt: Long): Boolean {
        if (!accepts(attempt)) return false
        availability = Availability.BLOCKED
        return true
    }
}
