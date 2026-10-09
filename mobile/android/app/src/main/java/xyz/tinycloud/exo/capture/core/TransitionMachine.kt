package xyz.tinycloud.exo.capture.core

/** Pure transition policy. gen owns an input attempt; epoch owns user actions. */
class TransitionMachine {
    enum class Intent { RECORDING, PAUSED, STOPPED }
    enum class Availability { AVAILABLE, INTERRUPTED, BLOCKED }
    enum class Event { INTERRUPTION_BEGAN, INTERRUPTION_ENDED, BACKOFF_EXHAUSTED, ROUTE_CHANGE,
        MEDIA_RESET, STALL, SILENCED, UNSILENCED, PAUSE, RESUME, STOP, DISCARD, APP_ACTIVE }

    @Volatile var intent = Intent.STOPPED; private set
    @Volatile var availability = Availability.AVAILABLE; private set
    @Volatile var gen = 0L; private set
    @Volatile var epoch = 0L; private set
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
                Event.STOP, Event.DISCARD -> { intent = Intent.STOPPED; availability = Availability.AVAILABLE; ++gen; ++epoch }
                else -> Unit
            }
            Intent.RECORDING -> when (event) {
                Event.PAUSE -> { intent = Intent.PAUSED; availability = Availability.AVAILABLE; silenced = false; ++gen; ++epoch }
                Event.STOP, Event.DISCARD -> { intent = Intent.STOPPED; availability = Availability.AVAILABLE; ++gen; ++epoch }
                Event.INTERRUPTION_BEGAN, Event.MEDIA_RESET, Event.STALL, Event.ROUTE_CHANGE -> {
                    availability = Availability.INTERRUPTED; silenced = false; ++gen
                    return event == Event.ROUTE_CHANGE
                }
                Event.INTERRUPTION_ENDED -> if (availability == Availability.INTERRUPTED) { ++gen; return true }
                Event.BACKOFF_EXHAUSTED -> availability = Availability.BLOCKED
                Event.SILENCED -> silenced = true
                Event.UNSILENCED -> silenced = false
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

    fun failed(attempt: Long, automatic: Boolean = false): Boolean {
        if (!accepts(attempt)) return false
        availability = if (automatic) Availability.INTERRUPTED else Availability.BLOCKED
        return true
    }

    fun writeFailed() {
        ++gen; ++epoch
        intent = Intent.STOPPED
        availability = Availability.BLOCKED
    }
}
