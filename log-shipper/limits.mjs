/** Lines longer than this are counted and dropped, never parsed. */
export const MAX_LINE_BYTES = 4096;
/** Per (component, event_code) cap per window; the overflow is reported as one `log_dropped` event per key and window. */
export const CAP_PER_WINDOW = 30;
export const CAP_WINDOW_SECONDS = 60;
