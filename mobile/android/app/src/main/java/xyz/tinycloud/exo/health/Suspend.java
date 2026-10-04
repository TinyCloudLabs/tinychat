package xyz.tinycloud.exo.health;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.CoroutineScope;
import kotlinx.coroutines.CoroutineStart;
import kotlinx.coroutines.future.FutureKt;

/**
 * Health Connect's client API is Kotlin {@code suspend} functions. Java sees each one as a method with a trailing
 * {@link Continuation} that returns either the result or COROUTINE_SUSPENDED. {@link FutureKt#future} runs such a
 * call inside a coroutine (the lambda only passes the continuation through) and hands back a CompletableFuture,
 * so the plugin can wait for it on its own worker thread. The app stays Java-only: no Kotlin Gradle plugin.
 */
final class Suspend {

    interface Call<T> {
        Object invoke(Continuation<? super T> continuation);
    }

    private static final long TIMEOUT_SECONDS = 60;

    private Suspend() {}

    /** Blocks the calling (worker) thread until the call finishes; rethrows the call's own exception. */
    static <T> T await(CoroutineScope scope, Call<T> call) throws Exception {
        try {
            return FutureKt
                .<T>future(scope, EmptyCoroutineContext.INSTANCE, CoroutineStart.DEFAULT, (s, continuation) -> call.invoke(continuation))
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw e;
        } catch (TimeoutException e) {
            throw new IllegalStateException("Health Connect did not answer within " + TIMEOUT_SECONDS + " s", e);
        }
    }
}
