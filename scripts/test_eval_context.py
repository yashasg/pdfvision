#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock
import uuid


SCRIPT_PATH = Path(__file__).with_name("eval-context.py")
SPEC = importlib.util.spec_from_file_location("eval_context", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
eval_context = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(eval_context)


class CharacterTokenizer:
    def encode(self, text: str, *, disallowed_special: object = ()) -> list[str]:
        del disallowed_special
        return list(text)


class EvalContextTests(unittest.TestCase):
    def test_retrieval_count_includes_outline_commands_sections_and_question(self) -> None:
        baseline, retrieval = eval_context.build_payloads(
            "# Full\nanswer evidence\n",
            "What is the answer?",
            '[{"id":"s1","title":"Full","level":1}]\n',
            [("s1", "# Full\nanswer evidence\n")],
        )
        report = eval_context.evaluate(
            markdown="# Full\nanswer evidence\n",
            question="What is the answer?",
            expected_evidence=["ANSWER EVIDENCE"],
            encoding_name="test-characters",
            sections=["s1"],
            outline='[{"id":"s1","title":"Full","level":1}]\n',
            section_outputs=[("s1", "# Full\nanswer evidence\n")],
            tokenizer=CharacterTokenizer(),
        )

        self.assertEqual(report["baseline_tokens"], len(baseline))
        self.assertEqual(report["retrieval_tokens"], len(retrieval))
        retrieval_object = json.loads(retrieval)
        self.assertIn(eval_context.command_description(), retrieval)
        self.assertIn(eval_context.command_description("s1"), retrieval)
        self.assertEqual(
            retrieval_object["calls"][0]["output"],
            '[{"id":"s1","title":"Full","level":1}]\n',
        )
        self.assertIn("What is the answer?", retrieval)
        self.assertGreater(
            report["retrieval_tokens"],
            len("What is the answer?") + len("# Full\nanswer evidence\n"),
        )
        self.assertTrue(report["evidence_retained"])

    def test_reports_negative_saving_honestly(self) -> None:
        report = eval_context.evaluate(
            markdown="# A\nproof\n",
            question="Proof?",
            expected_evidence=["proof"],
            encoding_name="test-characters",
            sections=["s1"],
            outline="x" * 500,
            section_outputs=[("s1", "# A\nproof\n" + "x" * 500)],
            tokenizer=CharacterTokenizer(),
        )

        self.assertLess(report["saved_tokens"], 0)
        self.assertLess(report["reduction_fraction"], 0)
        self.assertTrue(report["evidence_retained"])

    def test_missing_selected_evidence_makes_result_fail(self) -> None:
        report = eval_context.evaluate(
            markdown="# Selected\nsummary\n# Omitted\ncritical fact\n",
            question="What is critical?",
            expected_evidence=["critical fact"],
            encoding_name="test-characters",
            sections=["s1"],
            outline='[{"id":"s1","title":"Selected","level":1}]\n',
            section_outputs=[("s1", "# Selected\nsummary\n")],
            tokenizer=CharacterTokenizer(),
        )

        self.assertFalse(report["evidence_retained"])
        self.assertTrue(report["evidence_checks"][0]["baseline"])
        self.assertFalse(report["evidence_checks"][0]["retrieval"])

    def test_evidence_matching_handles_markdown_literal_escapes(self) -> None:
        report = eval_context.evaluate(
            markdown="# Price\nAmount: $123.45\n",
            question="What is the amount?",
            expected_evidence=["$123.45"],
            encoding_name="test-characters",
            sections=["s1"],
            outline='[{"id":"s1","title":"Price","level":1}]\n',
            section_outputs=[("s1", "# Price\nAmount\\: \\$123\\.45\n")],
            tokenizer=CharacterTokenizer(),
        )
        self.assertTrue(report["evidence_retained"])

    def test_missing_evidence_returns_nonzero_after_printing_report(self) -> None:
        with mock.patch.object(
            eval_context,
            "run",
            return_value={"evidence_retained": False, "saved_tokens": 10},
        ):
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                result = eval_context.main(
                    [
                        "input.md",
                        "--section",
                        "s1",
                        "--encoding",
                        "o200k_base",
                        "--question",
                        "Question?",
                        "--expect",
                        "missing evidence",
                    ]
                )

        self.assertEqual(result, 1)
        self.assertIn('"evidence_retained": false', stdout.getvalue())

    def test_duplicate_and_invalid_sections_are_usage_errors(self) -> None:
        common = [
            "input.md",
            "--encoding",
            "o200k_base",
            "--question",
            "Question?",
            "--expect",
            "evidence",
        ]
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as duplicate:
            eval_context.parse_args(common + ["--section", "s2", "--section", "s2"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as invalid:
            eval_context.parse_args(common + ["--section", "chapter-2"])

        self.assertEqual(duplicate.exception.code, 2)
        self.assertEqual(invalid.exception.code, 2)

    def test_missing_section_command_surfaces_nonzero_error(self) -> None:
        failed = mock.Mock(returncode=2, stdout="", stderr="unknown section")
        with mock.patch.object(eval_context.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(eval_context.EvalError, "unknown section"):
                eval_context.run_pdfvision(Path("pdfvision"), Path("input.md"), "s9")

    def test_missing_input_file_error(self) -> None:
        path = Path(__file__).parent / f".eval-context-missing-{uuid.uuid4().hex}.md"
        with self.assertRaisesRegex(eval_context.EvalError, "not a file"):
            eval_context.read_markdown(path)

    def test_strict_utf8_input_error(self) -> None:
        path = Path(__file__).parent / f".eval-context-invalid-{uuid.uuid4().hex}.md"
        try:
            path.write_bytes(b"\xff")
            with self.assertRaisesRegex(eval_context.EvalError, "not valid UTF-8"):
                eval_context.read_markdown(path)
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
