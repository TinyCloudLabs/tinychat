use std::io::{self, Read, Seek, SeekFrom, Write};

const PCM: u16 = 1;
const IEEE_FLOAT: u16 = 3;
const EXTENSIBLE: u16 = 0xfffe;
const IEEE_FLOAT_GUID: [u8; 16] = [
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub frames: u64,
    pub data_bytes: u64,
    pub channels: u16,
}

#[derive(Clone, Copy, Debug)]
struct Format {
    tag: u16,
    channels: u16,
    sample_rate: u32,
    block_align: u16,
    bits_per_sample: u16,
}

impl Format {
    fn read<R: Read + Seek>(source: &mut R, offset: u64, size: u32) -> io::Result<Self> {
        if size < 16 {
            return Err(invalid("WAV fmt chunk is shorter than WAVEFORMAT"));
        }
        source.seek(SeekFrom::Start(offset))?;
        let mut bytes = [0u8; 40];
        let amount = usize::try_from(size.min(bytes.len() as u32)).unwrap();
        source.read_exact(&mut bytes[..amount])?;
        let raw_tag = u16::from_le_bytes(bytes[0..2].try_into().unwrap());
        let channels = u16::from_le_bytes(bytes[2..4].try_into().unwrap());
        let sample_rate = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let block_align = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
        let bits_per_sample = u16::from_le_bytes(bytes[14..16].try_into().unwrap());
        let tag = match raw_tag {
            PCM | IEEE_FLOAT => raw_tag,
            EXTENSIBLE if size >= 40 && bytes[24..40] == IEEE_FLOAT_GUID => IEEE_FLOAT,
            EXTENSIBLE => return Err(invalid("WAV extensible format is not IEEE float")),
            _ => return Err(invalid("WAV format is neither PCM nor IEEE float")),
        };
        if channels == 0 || sample_rate == 0 || bits_per_sample == 0 {
            return Err(invalid("WAV format has invalid channel, rate, or bit count"));
        }
        let bytes_per_sample = u32::from(bits_per_sample).div_ceil(8);
        if u32::from(block_align) != u32::from(channels) * bytes_per_sample {
            return Err(invalid("WAV block alignment does not match channels and sample width"));
        }
        let valid_width = match tag {
            PCM => matches!(bits_per_sample, 8 | 16 | 24 | 32),
            IEEE_FLOAT => matches!(bits_per_sample, 32 | 64),
            _ => false,
        };
        if !valid_width || sample_rate.checked_mul(u32::from(block_align)).is_none() {
            return Err(invalid("WAV sample format is unsupported"));
        }
        Ok(Self { tag, channels, sample_rate, block_align, bits_per_sample })
    }
}

/// Copy the complete interleaved sample frames currently flushed into an open WAV source.
///
/// The source writer may still have placeholder RIFF and data lengths. This function treats
/// the file's physical end as the current data boundary, then emits a normalized 44-byte
/// PCM/IEEE-float header whose lengths describe only the copied whole-frame prefix.
pub fn snapshot<R: Read + Seek, W: Write>(source: &mut R, target: &mut W) -> io::Result<Option<Snapshot>> {
    let source_len = source.seek(SeekFrom::End(0))?;
    if source_len < 12 {
        return Err(invalid("WAV RIFF header is truncated"));
    }
    source.seek(SeekFrom::Start(0))?;
    let mut riff = [0u8; 12];
    source.read_exact(&mut riff)?;
    if &riff[..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(invalid("source is not a RIFF/WAVE file"));
    }

    let mut cursor = 12u64;
    let mut format = None;
    let mut data = None;
    while cursor.checked_add(8).is_some_and(|end| end <= source_len) {
        source.seek(SeekFrom::Start(cursor))?;
        let mut chunk = [0u8; 8];
        source.read_exact(&mut chunk)?;
        let size = u32::from_le_bytes(chunk[4..8].try_into().unwrap());
        let payload = cursor + 8;
        match &chunk[..4] {
            b"fmt " => format = Some(Format::read(source, payload, size)?),
            b"data" => {
                data = Some((payload, u64::from(size)));
                if format.is_some() {
                    break;
                }
            }
            _ => {}
        }
        let end = payload.checked_add(u64::from(size)).ok_or_else(|| invalid("WAV chunk offset overflow"))?;
        cursor = end.checked_add(u64::from(size & 1)).ok_or_else(|| invalid("WAV chunk offset overflow"))?;
    }
    let format = format.ok_or_else(|| invalid("WAV fmt chunk is missing"))?;
    let (data_offset, declared_data_bytes) = data.ok_or_else(|| invalid("WAV data chunk is missing"))?;
    if data_offset > source_len {
        return Err(invalid("WAV data chunk is truncated"));
    }
    // While a writer is open, Hound's data length remains zero. A finalized file instead
    // bounds its data chunk by the declared length, preventing a trailing chunk being copied.
    let available = source_len - data_offset;
    let data_bytes = if declared_data_bytes == 0 { available } else { available.min(declared_data_bytes) };
    let block_align = u64::from(format.block_align);
    let copied_bytes = data_bytes / block_align * block_align;
    if copied_bytes == 0 {
        return Ok(None);
    }
    let riff_size = copied_bytes.checked_add(36).and_then(|size| u32::try_from(size).ok())
        .ok_or_else(|| invalid("WAV snapshot exceeds RIFF's size limit"))?;
    let data_size = u32::try_from(copied_bytes).map_err(|_| invalid("WAV snapshot exceeds RIFF's size limit"))?;
    let byte_rate = format.sample_rate * u32::from(format.block_align);

    target.write_all(b"RIFF")?;
    target.write_all(&riff_size.to_le_bytes())?;
    target.write_all(b"WAVEfmt ")?;
    target.write_all(&16u32.to_le_bytes())?;
    target.write_all(&format.tag.to_le_bytes())?;
    target.write_all(&format.channels.to_le_bytes())?;
    target.write_all(&format.sample_rate.to_le_bytes())?;
    target.write_all(&byte_rate.to_le_bytes())?;
    target.write_all(&format.block_align.to_le_bytes())?;
    target.write_all(&format.bits_per_sample.to_le_bytes())?;
    target.write_all(b"data")?;
    target.write_all(&data_size.to_le_bytes())?;

    source.seek(SeekFrom::Start(data_offset))?;
    let mut remaining = copied_bytes;
    let mut buffer = [0u8; 8192];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
        source.read_exact(&mut buffer[..count])?;
        target.write_all(&buffer[..count])?;
        remaining -= count as u64;
    }
    Ok(Some(Snapshot { frames: copied_bytes / block_align, data_bytes: copied_bytes, channels: format.channels }))
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::snapshot;
    use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(Vec<PathBuf>);

    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!("wav-snapshot-{}-{id}", std::process::id()));
            Self(vec![base.with_extension("source.wav"), base.with_extension("snapshot.wav"), base.with_extension("again.wav")])
        }

        fn path(&self, index: usize) -> &std::path::Path { &self.0[index] }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { for path in &self.0 { let _ = std::fs::remove_file(path); } }
    }

    fn snapshot_path(source: &std::path::Path, target: &std::path::Path) -> super::Snapshot {
        let mut input = File::open(source).unwrap();
        let mut output = File::create(target).unwrap();
        snapshot(&mut input, &mut output).unwrap().unwrap()
    }

    #[test]
    fn snapshots_open_hound_float_writers_as_whole_frames_and_updates_after_append() {
        for channels in [1, 2] {
            let files = Fixture::new();
            let source_path = files.path(0);
            let spec = WavSpec { channels, sample_rate: 16_000, bits_per_sample: 32, sample_format: SampleFormat::Float };
            let mut writer = WavWriter::create(source_path, spec).unwrap();
            let initial_samples = channels as usize * 2;
            for index in 0..initial_samples { writer.write_sample(index as f32 / 10.0).unwrap(); }
            writer.flush().unwrap();

            let first = snapshot_path(source_path, files.path(1));
            let expected_first_frames = initial_samples / channels as usize;
            assert_eq!(first.frames, expected_first_frames as u64);
            assert_eq!(first.channels, channels);
            assert_eq!(first.data_bytes, first.frames * u64::from(channels) * 4);
            let mut reader = WavReader::open(files.path(1)).unwrap();
            assert_eq!(reader.spec(), spec);
            assert_eq!(reader.duration(), first.frames as u32);
            assert_eq!(reader.samples::<f32>().count(), expected_first_frames * channels as usize);

            for index in 0..(channels as usize * 2) { writer.write_sample(0.75 + index as f32 / 10.0).unwrap(); }
            writer.flush().unwrap();
            let second = snapshot_path(source_path, files.path(2));
            let expected_second_frames = (initial_samples + channels as usize * 2) / channels as usize;
            assert_eq!(second.frames, expected_second_frames as u64);
            let mut reader = WavReader::open(files.path(2)).unwrap();
            assert_eq!(reader.duration(), expected_second_frames as u32);
            assert_eq!(reader.samples::<f32>().count(), expected_second_frames * channels as usize);
            writer.finalize().unwrap();
        }
    }

    #[test]
    fn parser_accepts_extensible_float_and_pcm_chunk_layouts() {
        let samples = [0.25f32, -0.5];
        let mut extensible = Vec::new();
        extensible.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        extensible.extend_from_slice(&40u32.to_le_bytes());
        extensible.extend_from_slice(&0xfffeu16.to_le_bytes());
        extensible.extend_from_slice(&1u16.to_le_bytes());
        extensible.extend_from_slice(&16_000u32.to_le_bytes());
        extensible.extend_from_slice(&64_000u32.to_le_bytes());
        extensible.extend_from_slice(&4u16.to_le_bytes());
        extensible.extend_from_slice(&32u16.to_le_bytes());
        extensible.extend_from_slice(&22u16.to_le_bytes());
        extensible.extend_from_slice(&32u16.to_le_bytes());
        extensible.extend_from_slice(&4u32.to_le_bytes());
        extensible.extend_from_slice(&super::IEEE_FLOAT_GUID);
        extensible.extend_from_slice(b"data\0\0\0\0");
        for sample in samples { extensible.extend_from_slice(&sample.to_le_bytes()); }
        let mut output = Vec::new();
        let parsed = snapshot(&mut std::io::Cursor::new(extensible), &mut output).unwrap().unwrap();
        assert_eq!(parsed.frames, 2);
        assert_eq!(WavReader::new(std::io::Cursor::new(output)).unwrap().duration(), 2);

        // A JUNK chunk with padding proves the parser walks chunks rather than relying on offsets.
        let mut pcm = Vec::new();
        pcm.extend_from_slice(b"RIFF\0\0\0\0WAVEJUNK\x03\0\0\0abc\0fmt ");
        pcm.extend_from_slice(&16u32.to_le_bytes());
        pcm.extend_from_slice(&1u16.to_le_bytes());
        pcm.extend_from_slice(&1u16.to_le_bytes());
        pcm.extend_from_slice(&8_000u32.to_le_bytes());
        pcm.extend_from_slice(&16_000u32.to_le_bytes());
        pcm.extend_from_slice(&2u16.to_le_bytes());
        pcm.extend_from_slice(&16u16.to_le_bytes());
        pcm.extend_from_slice(b"data\0\0\0\0\x01\0\x02\0");
        let mut output = Vec::new();
        let parsed = snapshot(&mut std::io::Cursor::new(pcm), &mut output).unwrap().unwrap();
        assert_eq!(parsed.frames, 2);
        assert_eq!(WavReader::new(std::io::Cursor::new(output)).unwrap().duration(), 2);
    }

    #[test]
    fn ignores_trailing_partial_frame() {
        let files = Fixture::new();
        let spec = WavSpec { channels: 2, sample_rate: 16_000, bits_per_sample: 32, sample_format: SampleFormat::Float };
        let mut writer = WavWriter::create(files.path(0), spec).unwrap();
        writer.write_sample(0.5f32).unwrap();
        writer.write_sample(-0.5f32).unwrap();
        writer.flush().unwrap();
        OpenOptions::new().append(true).open(files.path(0)).unwrap().write_all(&[0u8; 3]).unwrap();
        let result = snapshot_path(files.path(0), files.path(1));
        assert_eq!(result.frames, 1);
        assert_eq!(std::fs::metadata(files.path(1)).unwrap().len(), 52);
        writer.finalize().unwrap();
    }
}
