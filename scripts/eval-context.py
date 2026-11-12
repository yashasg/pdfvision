#!/usr/bin/env python3
"""Measure tokenizer context saved by pdfvision Markdown retrieval."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from typing import Any, Callable, Sequence


DEFAULT_BINARY = ".build/release/pdfvision"
COMMAND_TIMEOUT_SECONDS = 30
SECTION_PATTERN = re.compile(r"s[0-9]+")


class EvalError(Exception):
    """A user-visible evaluation failure."""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compare exact tokenizer counts for full saved Markdown and "
            "pdfvision outline/section retrieval payloads."
        )
    )
    parser.add_argument("markdown", help="Saved Markdown input (strict UTF-8)")
    parser.add_argument(
        "--section",
        action="append",
        required=True,
        help="Section ID to retrieve; repeat for additional sections",
    )
    parser.add_argument(
        "--encoding",
        required=True,
        help="Explicit tiktoken encoding name, for example o200k_base",
    )
    parser.add_argument("--question", required=True, help="Question sent with either payload")
    parser.add_argument(
        "--expect",
        action="append",
        required=True,
        help="Required answer evidence; repeat for additional evidence",
    )
    parser.add_argument(
        "--binary",
        default=DEFAULT_BINARY,
        help=f"Release pdfvision binary (default: {DEFAULT_BINARY})",
    )
    args = parser.parse_args(argv)

    if not args.question.strip():
        parser.error("--question must not be empty")
    if not args.encoding.strip():
        parser.error("--encoding must not be empty")
    if any(not expected.strip() for expected in args.expect):
        parser.error("--expect values must not be empty")
    invalid_sections = [section for section in args.section if not SECTION_PATTERN.fullmatch(section)]
    if invalid_sections:
        parser.error(
            "invalid --section ID(s): "
            + ", ".join(invalid_sections)
            + " (expected s followed by digits)"
        )
    duplicates = sorted({section for section in args.section if args.section.count(section) > 1})
    if duplicates:
        parser.error("duplicate --section ID(s): " + ", ".join(duplicates))
    return args


def read_markdown(path: Path) -> str:
    if not path.is_file():
        raise EvalError(f"Markdown input is not a file: {path}")
    try:
        return path.read_text(encoding="utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise EvalError(f"Markdown input is not valid UTF-8: {path}: {error}") from error
    except OSError as error:
        raise EvalError(f"Could not read Markdown input {path}: {error}") from error


def validate_binary(path: Path) -> None:
    if not path.is_file():
        raise EvalError(f"pdfvision binary is not a file: {path}")
    if not os.access(path, os.X_OK):
        raise EvalError(f"pdfvision binary is not executable: {path}")


def command_description(section_id: str | None = None) -> str:
    arguments = ["pdfvision", "<markdown-file>", "--from-markdown"]
    if section_id is None:
        arguments.append("--outline")
    else:
        arguments.extend(["--section", section_id])
    return shlex.join(arguments)


def run_pdfvision(binary: Path, markdown: Path, section_id: str | None = None) -> str:
    arguments = [str(binary), str(markdown), "--from-markdown"]
    if section_id is None:
        arguments.append("--outline")
    else:
        arguments.extend(["--section", section_id])
    try:
        completed = subprocess.run(
            arguments,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="strict",
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise EvalError(
            f"pdfvision command timed out after {COMMAND_TIMEOUT_SECONDS}s: "
            f"{command_description(section_id)}"
        ) from error
    except UnicodeDecodeError as error:
        raise EvalError(
            f"pdfvision emitted non-UTF-8 output: {command_description(section_id)}: {error}"
        ) from error
    except OSError as error:
        raise EvalError(
            f"Could not run pdfvision command {command_description(section_id)}: {error}"
        ) from error

    if completed.returncode != 0:
        detail = completed.stderr.strip() or "no stderr"
        raise EvalError(
            f"pdfvision command failed with exit {completed.returncode}: "
            f"{command_description(section_id)}: {detail}"
        )
    return completed.stdout


def serialize_payload(question: str, calls: list[dict[str, str]]) -> str:
    return json.dumps(
        {"question": question, "calls": calls},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def build_payloads(
    markdown: str,
    question: str,
    outline: str,
    section_outputs: list[tuple[str, str]],
) -> tuple[str, str]:
    baseline_payload = serialize_payload(
        question,
        [{"command": "read full saved Markdown from <markdown-file>", "output": markdown}],
    )
    retrieval_calls = [
        {"command": command_description(), "output": outline},
        *[
            {"command": command_description(section_id), "output": output}
            for section_id, output in section_outputs
        ],
    ]
    return baseline_payload, serialize_payload(question, retrieval_calls)


def count_tokens(tokenizer: Any, text: str) -> int:
    return len(tokenizer.encode(text, disallowed_special=()))


def evidence_text(text: str) -> str:
    return re.sub(r"\\([!-/:-@\[-`{-~])", r"\1", text).casefold()


def evaluate(
    *,
    markdown: str,
    question: str,
    expected_evidence: list[str],
    encoding_name: str,
    sections: list[str],
    outline: str,
    section_outputs: list[tuple[str, str]],
    tokenizer: Any,
) -> dict[str, Any]:
    baseline_payload, retrieval_payload = build_payloads(
        markdown, question, outline, section_outputs
    )
    baseline_tokens = count_tokens(tokenizer, baseline_payload)
    retrieval_tokens = count_tokens(tokenizer, retrieval_payload)
    saved_tokens = baseline_tokens - retrieval_tokens

    baseline_folded = evidence_text(markdown)
    retrieval_folded = evidence_text("\n".join(
        [outline, *(output for _, output in section_outputs)]
    ))
    evidence_checks = [
        {
            "expect": expected,
            "baseline": evidence_text(expected) in baseline_folded,
            "retrieval": evidence_text(expected) in retrieval_folded,
        }
        for expected in expected_evidence
    ]
    evidence_retained = all(
        check["baseline"] and check["retrieval"] for check in evidence_checks
    )
    calls = [
        {
            "kind": "outline",
            "command": command_description(),
            "output_bytes": len(outline.encode("utf-8")),
        },
        *[
            {
                "kind": "section",
                "section_id": section_id,
                "command": command_description(section_id),
                "output_bytes": len(output.encode("utf-8")),
            }
            for section_id, output in section_outputs
        ],
    ]

    return {
        "encoding": encoding_name,
        "baseline_tokens": baseline_tokens,
        "retrieval_tokens": retrieval_tokens,
        "saved_tokens": saved_tokens,
        "reduction_fraction": saved_tokens / baseline_tokens if baseline_tokens else None,
        "byte_counts": {
            "source_markdown": len(markdown.encode("utf-8")),
            "baseline_payload": len(baseline_payload.encode("utf-8")),
            "retrieval_payload": len(retrieval_payload.encode("utf-8")),
        },
        "evidence_retained": evidence_retained,
        "evidence_match": (
            "case-insensitive substring with Markdown punctuation escapes normalized; "
            "baseline searches source Markdown and retrieval searches the outline "
            "plus all selected-section outputs"
        ),
        "evidence_checks": evidence_checks,
        "calls": calls,
        "sections": sections,
        "limitations": [
            "Counts cover these serialized text payloads only, not chat wrappers, native PDF tokens, image tokens, or provider billing.",
            "This eval does not measure LLM answer quality.",
            "Section IDs are caller-provided; this eval does not measure automatic section selection.",
            "tiktoken may fetch and cache the named encoding asset on first use; no document text is sent to a model API.",
        ],
    }


def load_tokenizer(encoding_name: str) -> Any:
    try:
        import tiktoken
    except ImportError as error:
        raise EvalError(
            "tiktoken is required; install scripts/requirements-context.txt "
            "in an eval-only environment"
        ) from error
    try:
        return tiktoken.get_encoding(encoding_name)
    except Exception as error:
        raise EvalError(f"Could not load tiktoken encoding {encoding_name!r}: {error}") from error


def run(
    args: argparse.Namespace,
    *,
    runner: Callable[[Path, Path, str | None], str] = run_pdfvision,
) -> dict[str, Any]:
    markdown_path = Path(args.markdown).resolve()
    binary_path = Path(args.binary).resolve()
    markdown = read_markdown(markdown_path)
    validate_binary(binary_path)
    tokenizer = load_tokenizer(args.encoding)

    outline = runner(binary_path, markdown_path, None)
    section_outputs = [
        (section_id, runner(binary_path, markdown_path, section_id))
        for section_id in args.section
    ]
    return evaluate(
        markdown=markdown,
        question=args.question,
        expected_evidence=args.expect,
        encoding_name=args.encoding,
        sections=args.section,
        outline=outline,
        section_outputs=section_outputs,
        tokenizer=tokenizer,
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = run(args)
    except EvalError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["evidence_retained"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
