"""Draws an aerial check image per validated address: the newest PDOK photo at native 8 cm/px,
with the plot (white), house (purple), outbuildings (violet), registered driveway crossings (yellow),
crossings within 15 m (thin yellow) and boundary stretches on roads or parking (orange).
Usage: python scripts/validate_images.py reports/validation-YYYY-MM-DD
"""
import io, json, re, sys, urllib.parse, urllib.request
from PIL import Image, ImageDraw

WMS = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0"
M_PER_PX = 0.08
MARGIN_M = 12

out = sys.argv[1]
rows = json.load(open(f"{out}/results.json"))["rows"]
for r in rows:
    d = r.get("draw")
    if not d:
        continue
    xs = [p[0] for p in d["plot"]]
    ys = [p[1] for p in d["plot"]]
    minx, miny = min(xs) - MARGIN_M, min(ys) - MARGIN_M
    maxx, maxy = max(xs) + MARGIN_M, max(ys) + MARGIN_M
    w = min(2000, round((maxx - minx) / M_PER_PX))
    h = min(2000, round((maxy - miny) / M_PER_PX))
    q = {
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": "Actueel_orthoHR",
        "STYLES": "", "CRS": "EPSG:28992", "BBOX": f"{minx},{miny},{maxx},{maxy}",
        "WIDTH": w, "HEIGHT": h, "FORMAT": "image/jpeg",
    }
    try:
        raw = urllib.request.urlopen(f"{WMS}?{urllib.parse.urlencode(q)}", timeout=60).read()
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:  # keep going; the table still has the numbers
        print("photo failed", r["address"], e)
        continue
    dr = ImageDraw.Draw(img)
    px = lambda p: ((p[0] - minx) / (maxx - minx) * w, (maxy - p[1]) / (maxy - miny) * h)
    ring = lambda poly: [px(p) for p in poly] + [px(poly[0])]
    for poly in d["inritsNear"]:
        dr.line(ring(poly), fill=(255, 220, 0), width=2)
    for poly in d["exits"]:
        dr.line(ring(poly), fill=(255, 220, 0), width=6)
    for poly in d["house"]:
        dr.line(ring(poly), fill=(140, 110, 255), width=4)
    for poly in d["outbuildings"]:
        dr.line(ring(poly), fill=(200, 170, 255), width=3)
    dr.line(ring(d["plot"]), fill=(255, 255, 255), width=4)
    for a, b in d["carEdges"]:
        dr.line([px(a), px(b)], fill=(255, 120, 0), width=8)
    dr.rectangle([0, 0, w, 34], fill=(0, 0, 0))
    dr.text((8, 10), f"{r['address']}  access: {r['access']}", fill=(255, 255, 255))
    if max(w, h) > 1100:  # keep files small; still ~10 cm/px for a typical plot
        img.thumbnail((1100, 1100))
    name = re.sub(r"[^a-z0-9]+", "-", r["address"].lower()).strip("-")
    img.save(f"{out}/{name}.jpg", quality=82)
    print("drew", name)
