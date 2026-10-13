"""Small fixture boundary tests; run with python3 -m unittest discover."""
import array
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from make_alternation import RATE, trim_speech
from prepare_ami import crop_rttm, crop_words
from score import diarization_error, window_many_to_one_mapping
from wer import reference_text, tokens


class FixtureTests(unittest.TestCase):
    def test_ami_crop_has_one_time_origin_and_drops_crossing_words(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.rttm"
            source.write_text("".join(
                f"SPEAKER ES2004a 1 {start} {duration} <NA> <NA> {label} <NA> <NA>\n"
                for start, duration, label in [
                    (299.5, 1, "FEE013"), (450, 1, "MEE014"),
                    (600, 1, "FEE016"), (899.5, 1, "MEO015")]))
            cropped = root / "cropped.rttm"
            crop_rttm(source, cropped)
            rows = [line.split() for line in cropped.read_text().splitlines()]
            self.assertEqual([(float(row[3]), float(row[4])) for row in rows],
                             [(0, 0.5), (150, 1), (300, 1), (599.5, 0.5)])

            archive = root / "words.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for letter, start in zip("ABCD", [300.1, 450.1, 600.1, 899.6]):
                    edge = '<w starttime="299.9" endtime="300.1">drop</w>' if letter == "A" else ""
                    output.writestr(f"ES2004a.{letter}.words.xml",
                                        f'<root><w starttime="{start}" endtime="{start + 0.1}">'
                                        f'{letter}</w>{edge}</root>')
            words_path = root / "words.json"
            crop_words(archive, cropped, words_path)
            words = json.loads(words_path.read_text())
            self.assertEqual([(item["text"], item["speaker"]) for item in words],
                             [("A", "FEE013"), ("B", "MEE014"),
                              ("C", "FEE016"), ("D", "MEO015")])
            self.assertTrue(all(0 <= item["start"] < item["end"] <= 600 for item in words))

    def test_alternation_trims_edge_silence_without_clipping_speech(self):
        samples = array.array("h", [0] * (RATE // 2) + [4000] * (2 * RATE) + [0] * (RATE // 2))
        trimmed = trim_speech(samples)
        self.assertGreaterEqual(len(trimmed), 2 * RATE)
        self.assertLess(len(trimmed), len(samples))
        self.assertEqual(max(trimmed), 4000)

    def test_json_transcript_reference_and_many_to_one_speaker_merge(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "turns.json"
            path.write_text(json.dumps([{"text": "A kind"}, {"text": "of WORD"}]))
            self.assertEqual(tokens(reference_text(path)), ["a", "kind", "of", "word"])

        ref = [(0.0, 1.0, "A")]
        hyp = [(0.0, 1.0, "w0_speaker_0"), (0.0, 1.0, "w0_speaker_1")]
        reference_frames = [{"A"}] * 100
        hypothesis_frames = [{"w0_speaker_0", "w0_speaker_1"}] * 100
        mapping = window_many_to_one_mapping(ref, hyp, reference_frames, hypothesis_frames)
        self.assertEqual(mapping, {"w0_speaker_0": "A", "w0_speaker_1": "A"})
        self.assertEqual(diarization_error(ref, reference_frames, hypothesis_frames, mapping)[0], 0)


if __name__ == "__main__":
    unittest.main()
