"""Strict XML well-formedness check (expat) for every XML part of a .docx or .epub.

Usage: python3 xmlcheck.py FILE.docx|FILE.epub
Prints one line per part and exits non-zero if any part is not well-formed.
"""
import sys
import zipfile
import xml.dom.minidom

XML_EXT = ('.xml', '.rels', '.xhtml', '.opf', '.ncx')

def main(path):
    bad = 0
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if not info.filename.endswith(XML_EXT):
                continue
            try:
                xml.dom.minidom.parseString(z.read(info.filename))
                print('ok   ' + info.filename)
            except Exception as exc:  # noqa: BLE001 - report every parser error
                bad += 1
                print('FAIL ' + info.filename + ': ' + str(exc))
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
