#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PYTHON_BIN="${MARKITDOWN_SETUP_PYTHON:-python3}"

cd "${PROJECT_ROOT}"
"${PYTHON_BIN}" -m venv .venv-markitdown
.venv-markitdown/bin/python -m pip install --no-cache-dir -r requirements-markitdown.txt
.venv-markitdown/bin/python -c "from markitdown.converters._pdf_converter import PdfConverter; import pdfplumber; print('MarkItDown PDF 环境安装完成')"
