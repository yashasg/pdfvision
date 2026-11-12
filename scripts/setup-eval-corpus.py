#!/usr/bin/env python3
"""Prepare the digital-only benchmark corpus on a GitHub Actions runner."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import urllib.request
import zipfile


SOURCE = {
    "name": "Sinabis 10k synthetic PDF",
    "repository": "sinabis-group/sinabis-10k-synthetic-pdf",
    "revision": "40cc6716836baa5c3629ae9dba11c3319875a34c",
    "license": "CC-BY-4.0",
    "attribution": "Sinabis GmbH (2026). Sinabis Green Energy – Synthetic Document Dataset (10k PDFs).",
}
ARCHIVE = {
    "path": "Sinabis_10k_pdfs.zip",
    "bytes": 655411393,
    "sha256": "4deb0aee64f2f97d8ba4301bde6a784d5472a113b72bf9fda420b79f36cc39fe",
}
NOTICE = {
    "path": "README.md",
    "bytes": 10977,
    "sha256": "4e3aa88990d238cb31fa73a01dc0f3a181c8a6f78c6020be3e9a3af60ae3cf12",
}
TOTAL_DOCUMENTS = 10100
DIGITAL_DOCUMENTS = 6498


def safe_path(name):
    path = PurePosixPath(name)
    if "\\" in name or path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Unsafe archive path: {name}")
    return path


def download(asset, destination):
    url = (
        f"https://huggingface.co/datasets/{SOURCE['repository']}/resolve/"
        f"{SOURCE['revision']}/{asset['path']}"
    )
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(url, timeout=60) as response, destination.open("xb") as output:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > asset["bytes"]:
                raise ValueError(f"{asset['path']}: download exceeds pinned size")
            digest.update(chunk)
            output.write(chunk)
    if size != asset["bytes"] or digest.hexdigest() != asset["sha256"]:
        raise ValueError(f"{asset['path']}: pinned size or SHA-256 mismatch")


def select_digital(archive, expected_total=TOTAL_DOCUMENTS, expected_digital=DIGITAL_DOCUMENTS):
    members = {}
    manifest_names = []
    expanded_bytes = 0
    for info in archive.infolist():
        path = safe_path(info.filename)
        if info.filename in members:
            raise ValueError(f"Duplicate ZIP member: {info.filename}")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ValueError(f"Symlink ZIP member: {info.filename}")
        members[info.filename] = info
        expanded_bytes += info.file_size
        if expanded_bytes > 2 * 1024**3:
            raise ValueError("Archive exceeds the 2 GiB extraction limit")
        if path.parts[0] == "manifest" and path.suffix == ".jsonl":
            if info.file_size > 32 * 1024**2:
                raise ValueError(f"Manifest is too large: {info.filename}")
            manifest_names.append(info.filename)

    documents = []
    ids = set()
    paths = set()
    for name in sorted(manifest_names):
        for line in archive.read(name).decode("utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            if type(record.get("idx")) is not int or record["idx"] < 0:
                raise ValueError("Invalid manifest document index")
            if type(record.get("scanned")) is not bool:
                raise ValueError("Missing or non-boolean scanned flag")
            source_path = safe_path(record.get("file", ""))
            if source_path.parts[0] != "pdf" or source_path.suffix.lower() != ".pdf":
                raise ValueError(f"Invalid PDF path: {source_path}")
            if not re.fullmatch(r"[a-z0-9_]+", record.get("theme", "")):
                raise ValueError("Invalid document theme")
            if record["idx"] in ids or str(source_path) in paths:
                raise ValueError("Duplicate manifest document")
            ids.add(record["idx"])
            paths.add(str(source_path))
            info = members.get(str(source_path))
            if info is None or info.is_dir():
                raise ValueError(f"Missing PDF: {source_path}")
            if type(record.get("bytes")) is not int or record["bytes"] != info.file_size:
                raise ValueError(f"PDF size mismatch: {source_path}")
            if info.file_size > 64 * 1024**2:
                raise ValueError(f"PDF exceeds the 64 MiB limit: {source_path}")
            if not record["scanned"]:
                documents.append({
                    "id": f"sinabis-{record['idx']}",
                    "category": record["theme"],
                    "path": str(source_path),
                    "scanned": False,
                })
    if len(ids) != expected_total or len(documents) != expected_digital:
        raise ValueError(
            f"Unexpected corpus counts: {len(ids)} total / {len(documents)} digital; "
            f"expected {expected_total} / {expected_digital}"
        )
    return sorted(documents, key=lambda document: int(document["id"].split("-")[1]))


def extract_digital(archive, documents, destination):
    for document in documents:
        path = destination.joinpath(*safe_path(document["path"]).parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(document["path"]) as source, path.open("xb") as output:
            header = source.read(1024)
            if b"%PDF-" not in header:
                raise ValueError(f"Invalid PDF header: {document['path']}")
            output.write(header)
            shutil.copyfileobj(source, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Corpus downloads run only in GitHub Actions, not on this device")
    destination = args.destination.resolve()
    if destination.exists():
        raise ValueError(f"Destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pdfvision-corpus-", dir=destination.parent) as temp:
        temporary = Path(temp)
        download(ARCHIVE, temporary / "corpus.zip")
        prepared = temporary / "prepared"
        prepared.mkdir()
        download(NOTICE, prepared / "SOURCE-README.md")
        with zipfile.ZipFile(temporary / "corpus.zip") as archive:
            documents = select_digital(archive)
            extract_digital(archive, documents, prepared)
        for document in documents:
            document["path"] = str(destination / document["path"])
        manifest = {"schemaVersion": 1, "source": SOURCE, "documents": documents}
        (prepared / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        prepared.rename(destination)
    print(f"Prepared {len(documents)} digital PDFs; scanned PDFs excluded.")
    print(f"Manifest: {destination / 'manifest.json'}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"setup-eval-corpus: {error}", file=sys.stderr)
        sys.exit(1)
