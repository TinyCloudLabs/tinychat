package xyz.tinycloud.exo.stt.core

import android.net.NetworkCapabilities

/**
 * What the Wi-Fi model-transfer binding asks `ConnectivityManager.registerNetworkCallback` for
 * (round-3 finding 3): transport + capability constants only, kept separate from
 * `NetworkRequest.Builder` itself so this exact set is checkable from a plain JVM test without
 * touching any real Android networking API (`NetworkRequest.Builder` throws "not mocked" outside
 * an instrumented test). `NET_CAPABILITY_VALIDATED` is deliberately absent: Android's
 * `ConnectivityManager.requestNetwork` rejects a mutable capability like VALIDATED in the request
 * itself and additionally needs `CHANGE_NETWORK_STATE`, which this app does not declare. Instead
 * the binding asks `registerNetworkCallback` -- which needs no extra permission, since it only
 * observes networks Android already has, rather than bringing one up -- for any Wi-Fi network
 * with internet, and checks VALIDATED itself on the capabilities Android reports back.
 */
internal object WifiNetworkRequestSpec {
    val requiredTransport: Int = NetworkCapabilities.TRANSPORT_WIFI
    val requiredCapability: Int = NetworkCapabilities.NET_CAPABILITY_INTERNET
    val validatedCapability: Int = NetworkCapabilities.NET_CAPABILITY_VALIDATED
}
