package xyz.tinycloud.exo.capture

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioUploadCancellationTest {
    @Test fun cancellationBeforeUploadStartsIsRememberedAndConsumed() {
        val cancellation = AudioUploadCancellation()
        cancellation.cancel("upload-1")
        assertTrue(cancellation.consume("upload-1"))
        assertFalse(cancellation.consume("upload-1"))
    }

    @Test fun cancellationForAnotherUploadDoesNotBlockThisOne() {
        val cancellation = AudioUploadCancellation()
        cancellation.cancel("upload-1")
        assertFalse(cancellation.consume("upload-2"))
        assertTrue(cancellation.consume("upload-1"))
    }
}
