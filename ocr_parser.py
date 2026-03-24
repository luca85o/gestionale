import sys
import json
import re
from pdf2image import convert_from_path
import pytesseract

pdf_path = sys.argv[1]

def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()

def should_ignore(desc: str) -> bool:
    t = (desc or "").lower()
    return any(x in t for x in [
        "trasporto",
        "spedizione",
        "sconto",
        "concessovi",
        "quota fissa",
        "totale",
        "iva",
    ])

def parse_lines(text: str):
    rows = []
    for raw in text.splitlines():
        line = norm(raw)
        if not line:
            continue

        # Typical Cimmino OCR line
        # 8308146 FEDERA BRILLANTE U. B.CO DA 10 R 55X 90 NR 10 1,19 11,90
        m = re.match(
            r'^(@?[A-Z0-9]{5,8})\s+(.+?)\s+\b(NR|PZ|CF|CT)\b\s+(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)$',
            line,
            re.I
        )
        if m:
            code = m.group(1).strip()
            desc = norm(m.group(2))
            qty = float(m.group(4).replace(",", "."))
            rows.append({
                "ean": "",
                "supplierCode": code,
                "description": desc,
                "qty": qty,
                "action": "ignore" if should_ignore(desc) or code.startswith("@") or qty <= 0 else "map",
                "createAlias": False if should_ignore(desc) or code.startswith("@") or qty <= 0 else True,
                "fulfillmentSource": "warehouse"
            })
            continue

        # Transport/discount rows
        if "@TRASP" in line.upper() or "@SCONT" in line.upper() or should_ignore(line):
            rows.append({
                "ean": "",
                "supplierCode": "",
                "description": line,
                "qty": 1,
                "action": "ignore",
                "createAlias": False,
                "fulfillmentSource": "supplier"
            })
    return rows

all_rows = []
try:
    images = convert_from_path(pdf_path, dpi=260)
    for img in images[:3]:
        text = pytesseract.image_to_string(img, lang="eng")
        all_rows.extend(parse_lines(text))
except Exception:
    pass

# Deduplicate very similar rows
seen = set()
deduped = []
for r in all_rows:
    key = (r["supplierCode"], r["description"], str(r["qty"]), r["action"])
    if key not in seen:
        seen.add(key)
        deduped.append(r)

print(json.dumps({"rows": deduped}, ensure_ascii=False))