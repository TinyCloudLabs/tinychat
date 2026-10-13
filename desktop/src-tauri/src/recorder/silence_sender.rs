use std::sync::mpsc::{self, Sender};

/// listener-core retains the sender for the session. Mic-only capture needs no output device.
pub(crate) fn silence_sender(
    system_audio: bool,
    open_output: impl FnOnce() -> Sender<()>,
) -> Sender<()> {
    if system_audio {
        open_output()
    } else {
        let (sender, _receiver) = mpsc::channel();
        sender
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mic_only_capture_never_opens_an_output_stream() {
        let mut opened = 0;
        let sender = silence_sender(false, || {
            opened += 1;
            mpsc::channel().0
        });
        assert_eq!(opened, 0);
        assert!(sender.send(()).is_err());

        let _sender = silence_sender(true, || {
            opened += 1;
            mpsc::channel().0
        });
        assert_eq!(opened, 1);
    }
}
