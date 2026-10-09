package xyz.tinycloud.exo.stt.core

import android.net.NetworkCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class WifiNetworkRequestSpecTest {
    @Test fun asksForWifiTransport() {
        assertEquals(NetworkCapabilities.TRANSPORT_WIFI, WifiNetworkRequestSpec.requiredTransport)
    }

    @Test fun asksForInternetCapability() {
        assertEquals(NetworkCapabilities.NET_CAPABILITY_INTERNET, WifiNetworkRequestSpec.requiredCapability)
    }

    @Test fun neverAsksForTheMutableValidatedCapability() {
        // ConnectivityManager.requestNetwork rejects a mutable capability like VALIDATED in the
        // request itself (round-3 finding 3): `requiredCapability`, the only capability this spec
        // puts on the request builder, must never be VALIDATED. Checking it is a separate step,
        // against the capabilities Android reports back -- not something to request.
        assertNotEquals(NetworkCapabilities.NET_CAPABILITY_VALIDATED, WifiNetworkRequestSpec.requiredCapability)
        assertNotEquals(NetworkCapabilities.NET_CAPABILITY_VALIDATED, WifiNetworkRequestSpec.requiredTransport)
    }

    @Test fun validatedCapabilityIsTheRealAndroidConstant() {
        assertEquals(NetworkCapabilities.NET_CAPABILITY_VALIDATED, WifiNetworkRequestSpec.validatedCapability)
    }
}
