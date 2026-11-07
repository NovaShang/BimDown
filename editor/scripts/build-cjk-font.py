"""Build the CJK font embedded by the PDF plan export.

Source: Noto Sans SC variable TTF (SIL OFL 1.1) from google/fonts:
  https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
Output: src/assets/fonts/NotoSansSC-Regular-subset.ttf — static wght 400,
TrueType outlines (jsPDF can't embed CFF), subset to GB2312 (all 6763 hanzi
and its symbols) plus Latin and CJK/fullwidth punctuation. jsPDF further
subsets to the glyphs a drawing actually uses, so PDFs stay small.

Usage: python3 scripts/build-cjk-font.py <path to NotoSansSC[wght].ttf>
Needs fonttools (pip install fonttools).
"""
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'fonts', 'NotoSansSC-Regular-subset.ttf')

chars = set(range(0x20, 0x7F)) | set(range(0xA0, 0x180))  # ASCII, Latin-1, Latin Extended-A
chars |= set(range(0x2000, 0x2070))  # general punctuation
chars |= set(range(0x2100, 0x2300))  # letterlike, number forms, arrows, math
chars |= set(range(0x2460, 0x2500)) | set(range(0x25A0, 0x2600))  # enclosed numbers, shapes
chars |= set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFFF0))  # CJK punctuation, fullwidth forms
chars |= {0x2300, 0x33A1, 0x33A5}  # diameter, m², m³
for hi in range(0xA1, 0xF8):
    for lo in range(0xA1, 0xFF):
        try:
            chars.add(ord(bytes([hi, lo]).decode('gb2312')))
        except UnicodeDecodeError:
            pass

font = instancer.instantiateVariableFont(TTFont(src), {'wght': 400})
opts = subset.Options()
opts.layout_features = []  # jsPDF does no shaping
opts.hinting = False
opts.drop_tables += ['GSUB', 'GPOS', 'GDEF', 'STAT', 'MVAR', 'HVAR', 'DSIG']
opts.name_IDs = ['*']
opts.notdef_outline = True
subsetter = subset.Subsetter(opts)
subsetter.populate(unicodes=chars)
subsetter.subset(font)
os.makedirs(os.path.dirname(out), exist_ok=True)
font.save(out)
print('glyphs', len(font.getGlyphOrder()), 'mapped', len(font.getBestCmap()), '->', os.path.abspath(out))
