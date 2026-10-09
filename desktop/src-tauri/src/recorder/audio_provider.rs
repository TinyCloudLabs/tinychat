//! Routes desktop capture through anarlog's audio provider and meters its PCM.
//! Mic-only capture never opens ScreenCaptureKit when system audio is off.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use audio_actual::{AudioProvider, CaptureConfig, CaptureStream, Error};
use futures_util::StreamExt;

#[derive(Default)]
pub struct Meter {
    pub level: f32,
    pub peak: f32,
}

impl Meter {
    fn amplitude(samples: &[f32]) -> (f32, f32) {
        if samples.is_empty() {
            return (0.0, 0.0);
        }
        let mut sum = 0.0_f32;
        let mut peak = 0.0_f32;
        for sample in samples.iter().copied().filter(|sample| sample.is_finite()) {
            sum += sample * sample;
            peak = peak.max(sample.abs());
        }
        (
            (sum / samples.len() as f32).sqrt().clamp(0.0, 1.0),
            peak.clamp(0.0, 1.0),
        )
    }

    pub fn observe(&mut self, mic: &[f32], speaker: &[f32]) {
        let (mic_level, mic_peak) = Self::amplitude(mic);
        let (speaker_level, speaker_peak) = Self::amplitude(speaker);
        self.level = mic_level.max(speaker_level);
        self.peak = self.peak.max(mic_peak).max(speaker_peak);
    }

    pub fn take(&mut self) -> (f32, f32) {
        let reading = (self.level, self.peak.max(self.level));
        self.peak = self.level;
        reading
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

pub struct SelectableAudio {
    actual: audio_actual::ActualAudio,
    system_audio: Arc<AtomicBool>,
    meter: Arc<Mutex<Meter>>,
}

impl SelectableAudio {
    pub fn new(system_audio: Arc<AtomicBool>, meter: Arc<Mutex<Meter>>) -> Self {
        Self {
            actual: audio_actual::ActualAudio,
            system_audio,
            meter,
        }
    }

    fn metered(&self, stream: CaptureStream) -> CaptureStream {
        let meter = self.meter.clone();
        CaptureStream::new(stream.map(move |frame| {
            if let Ok(ref frame) = frame {
                if let Ok(mut meter) = meter.lock() {
                    meter.observe(&frame.raw_mic, &frame.raw_speaker);
                }
            }
            frame
        }))
    }
}

impl AudioProvider for SelectableAudio {
    fn open_capture(&self, config: CaptureConfig) -> Result<CaptureStream, Error> {
        let stream = if self.system_audio.load(Ordering::SeqCst) {
            self.actual.open_capture(config)
        } else {
            self.actual
                .open_mic_capture(config.mic_device, config.sample_rate, config.chunk_size)
        }?;
        Ok(self.metered(stream))
    }
    fn open_speaker_capture(
        &self,
        sample_rate: u32,
        chunk_size: usize,
    ) -> Result<CaptureStream, Error> {
        self.actual.open_speaker_capture(sample_rate, chunk_size)
    }
    fn open_mic_capture(
        &self,
        device: Option<String>,
        sample_rate: u32,
        chunk_size: usize,
    ) -> Result<CaptureStream, Error> {
        self.actual
            .open_mic_capture(device, sample_rate, chunk_size)
            .map(|stream| self.metered(stream))
    }
    fn default_device_name(&self) -> String {
        self.actual.default_device_name()
    }
    fn list_mic_devices(&self) -> Vec<String> {
        self.actual.list_mic_devices()
    }
    fn play_silence(&self) -> std::sync::mpsc::Sender<()> {
        self.actual.play_silence()
    }
    fn play_bytes(&self, bytes: &'static [u8]) -> std::sync::mpsc::Sender<()> {
        self.actual.play_bytes(bytes)
    }
    fn probe_mic(&self, device: Option<String>) -> Result<(), Error> {
        self.actual.probe_mic(device)
    }
    fn probe_speaker(&self) -> Result<(), Error> {
        self.actual.probe_speaker()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meter_uses_pcm_rms_and_peak() {
        let mut meter = Meter::default();
        meter.observe(&[0.0, 0.5, -1.0, 0.5], &[]);
        let (level, peak) = meter.take();
        assert!(level > 0.5 && level < 1.0);
        assert_eq!(peak, 1.0);
        meter.reset();
        assert_eq!(meter.take(), (0.0, 0.0));
        meter.observe(&[0.0; 4], &[0.5; 4]);
        assert_eq!(meter.take(), (0.5, 0.5));
    }
}
