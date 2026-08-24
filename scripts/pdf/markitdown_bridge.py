#!/usr/bin/env python3
"""Convert one PDF from stdin to Markdown on stdout using Microsoft MarkItDown.

MarkItDown is MIT licensed by Microsoft Corporation. The project pins version
0.1.7 and invokes only its PDF converter, avoiding path or URL handling for
untrusted uploads.
"""

from __future__ import annotations

import io
import sys

from markitdown import StreamInfo
from markitdown.converters._pdf_converter import PdfConverter


def main() -> None:
    pdf_bytes = sys.stdin.buffer.read(16 * 1024 * 1024)
    if not pdf_bytes.startswith(b"%PDF-"):
        raise SystemExit("Input is not a PDF stream")
    result = PdfConverter().convert(
        io.BytesIO(pdf_bytes),
        StreamInfo(extension=".pdf", mimetype="application/pdf"),
    )
    sys.stdout.write(result.markdown)


if __name__ == "__main__":
    main()
