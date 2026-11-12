import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


spec = importlib.util.spec_from_file_location(
    "setup_eval_corpus", Path(__file__).with_name("setup-eval-corpus.py")
)
corpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus)


def fixture(scanned=False, **changes):
    record = {
        "idx": 0, "file": "pdf/invoice/0.pdf", "theme": "invoice",
        "scanned": scanned, "bytes": 17,
    }
    return {**record, **changes}


def archive(records, extra=None):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as output:
        for record in records:
            output.writestr(record["file"], b"%PDF-1.4\nfixture\n")
        output.writestr("manifest/b00000.jsonl", "\n".join(map(json.dumps, records)))
        if extra:
            output.writestr(*extra)
    data.seek(0)
    return zipfile.ZipFile(data)


class CorpusSetupTests(unittest.TestCase):
    def test_setup_reads_utf8_zip_names_without_the_utf8_flag(self):
        record = fixture(file="pdf/receipt/0000127_BON-MÜL.pdf")
        with archive([record]) as source:
            data = bytearray(source.fp.getvalue())
        for signature, flag_offset in [(b"PK\x03\x04", 6), (b"PK\x01\x02", 8)]:
            offset = 0
            while (offset := data.find(signature, offset)) >= 0:
                position = offset + flag_offset
                flags = int.from_bytes(data[position:position + 2], "little") & ~0x800
                data[position:position + 2] = flags.to_bytes(2, "little")
                offset += len(signature)
        select = corpus.select_digital

        def fake_download(asset, destination):
            destination.write_bytes(data if asset is corpus.ARCHIVE else b"fixture attribution")

        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "prepared"
            with patch.object(corpus, "download", side_effect=fake_download), patch.object(
                corpus, "select_digital",
                side_effect=lambda source: select(source, expected_total=1, expected_digital=1),
            ), patch.object(corpus.sys, "argv", [spec.origin, str(destination)]), patch.dict(
                corpus.os.environ, {"GITHUB_ACTIONS": "true"},
            ), patch("sys.stdout", new_callable=io.StringIO):
                corpus.main()
            self.assertTrue((destination / record["file"]).is_file())
            manifest = json.loads((destination / "manifest.json").read_text())
            self.assertEqual(
                manifest["documents"][0]["path"], str(destination.resolve() / record["file"])
            )

    def test_download_verifies_pinned_content_without_network(self):
        data = b"fixture archive"
        asset = {
            "path": "fixture.zip", "bytes": len(data),
            "sha256": corpus.hashlib.sha256(data).hexdigest(),
        }
        with tempfile.TemporaryDirectory() as temp:
            for name, response in [("valid", data), ("corrupt", b"x" * len(data)), ("oversize", data + b"x")]:
                with self.subTest(name=name), patch.object(
                    corpus.urllib.request, "urlopen", return_value=io.BytesIO(response)
                ) as request:
                    destination = Path(temp) / name
                    if name == "valid":
                        corpus.download(asset, destination)
                        self.assertEqual(destination.read_bytes(), data)
                    else:
                        with self.assertRaises(ValueError):
                            corpus.download(asset, destination)
                    self.assertIn(corpus.SOURCE["revision"], request.call_args.args[0])

    def test_selects_only_explicit_digital_records_and_extracts_no_scans(self):
        digital = fixture(bytes=17)
        scanned = fixture(True, idx=1, file="pdf/invoice/1.pdf", bytes=17)
        with archive([digital, scanned]) as source, tempfile.TemporaryDirectory() as temp:
            selected = corpus.select_digital(source, expected_total=2, expected_digital=1)
            self.assertEqual(selected, [{
                "id": "sinabis-0", "category": "invoice", "path": digital["file"], "scanned": False,
            }])
            corpus.extract_digital(source, selected, Path(temp))
            self.assertTrue((Path(temp) / digital["file"]).is_file())
            self.assertFalse((Path(temp) / scanned["file"]).exists())

    def test_rejects_ambiguous_metadata_counts_and_unsafe_members(self):
        for record in [fixture(scanned="false", bytes=17), fixture(bytes=999)]:
            with self.subTest(record=record), archive([record]) as source:
                with self.assertRaises(ValueError):
                    corpus.select_digital(source, expected_total=1, expected_digital=1)
        with archive([fixture(bytes=17)]) as source:
            with self.assertRaisesRegex(ValueError, "Unexpected corpus counts"):
                corpus.select_digital(source, expected_total=2, expected_digital=1)
        for path in ["../escape.pdf", "/absolute.pdf", r"pdf\escape.pdf"]:
            with self.subTest(path=path), archive([fixture(bytes=17)], (path, b"bad")) as source:
                with self.assertRaisesRegex(ValueError, "Unsafe archive path"):
                    corpus.select_digital(source, expected_total=1, expected_digital=1)
        link = zipfile.ZipInfo("pdf/link.pdf")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with archive([fixture(bytes=17)], (link, b"/etc/passwd")) as source:
            with self.assertRaisesRegex(ValueError, "Symlink ZIP member"):
                corpus.select_digital(source, expected_total=1, expected_digital=1)

    def test_download_command_refuses_local_execution_without_side_effects(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "not-created"
            environment = {key: value for key, value in os.environ.items() if key != "GITHUB_ACTIONS"}
            result = subprocess.run(
                [sys.executable, spec.origin, str(destination)],
                env=environment, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("only in GitHub Actions", result.stderr)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
