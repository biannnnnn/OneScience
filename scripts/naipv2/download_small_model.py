#!/usr/bin/env python3
"""Download and record a pinned Hugging Face base model snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--local-dir", required=True)
    parser.add_argument("--revision")
    args = parser.parse_args()

    local_dir = Path(args.local_dir).resolve()
    manifest_path = local_dir / "onescience-download-manifest.json"
    if manifest_path.exists():
        print(manifest_path.read_text(encoding="utf-8"))
        return

    info = HfApi().model_info(args.model_id, revision=args.revision)
    resolved_revision = info.sha
    snapshot_download(
        repo_id=args.model_id,
        revision=resolved_revision,
        local_dir=local_dir,
        local_dir_use_symlinks=False,
    )
    tracked = {}
    for name in ("config.json", "tokenizer_config.json", "generation_config.json"):
        path = local_dir / name
        if path.is_file():
            tracked[name] = sha256_file(path)
    payload = {
        "schema_version": "1.0.0",
        "model_id": args.model_id,
        "resolved_revision": resolved_revision,
        "tracked_sha256": tracked,
    }
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
