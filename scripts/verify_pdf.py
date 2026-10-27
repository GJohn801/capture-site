#!/usr/bin/env python3
"""Check PDF page count and actual text extraction; optionally render a preview."""

import argparse
import json
from pathlib import Path

from pypdf import PdfReader


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", type=Path, nargs="+")
    parser.add_argument("--single-page", action="store_true")
    parser.add_argument("--require-text", action="store_true")
    parser.add_argument("--contains", action="append", default=[], help="Required text (repeatable)")
    parser.add_argument("--preview-dir", type=Path, help="Render page previews (requires pymupdf)")
    args = parser.parse_args()
    failed = False
    for file in args.files:
        try:
            reader = PdfReader(file)
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            errors = []
            if args.single_page and len(reader.pages) != 1:
                errors.append(f"Expected one page, found {len(reader.pages)}")
            if args.require_text and not text.strip():
                errors.append("No extractable text")
            for phrase in args.contains:
                if phrase not in text:
                    errors.append(f"Missing text: {phrase}")
            if args.preview_dir:
                import pymupdf

                args.preview_dir.mkdir(parents=True, exist_ok=True)
                with pymupdf.open(file) as document:
                    for index, page in enumerate(document):
                        scale = min(1, 2000 / max(page.rect.width, page.rect.height))
                        page.get_pixmap(matrix=pymupdf.Matrix(scale, scale)).save(
                            args.preview_dir / f"{file.stem}-page-{index + 1}.png"
                        )
            print(json.dumps({
                "file": str(file), "pages": len(reader.pages),
                "text_characters": len(text.strip()),
                "page_sizes_points": [[float(p.mediabox.width), float(p.mediabox.height)] for p in reader.pages],
                "errors": errors,
            }))
            failed |= bool(errors)
        except Exception as error:
            print(json.dumps({"file": str(file), "errors": [str(error)]}))
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
