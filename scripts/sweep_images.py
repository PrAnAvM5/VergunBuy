"""Aerial check image per home with the obstacle cells coloured by height:
blue >= 1.0 m, yellow >= 1.5 m, orange >= 2.0 m, red >= 2.5 m. Plot white, house purple,
other registered buildings light purple, registered structures (canopies, pools) cyan.
Usage: python scripts/sweep_images.py reports/obstacles-YYYY-MM-DD
"""
import io, json, re, sys, urllib.parse, urllib.request
from PIL import Image, ImageDraw

WMS = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0"
out = sys.argv[1]
COLS = [(2.5, (255, 40, 40, 150)), (2.0, (255, 140, 0, 140)), (1.5, (255, 210, 0, 130)), (1.0, (80, 160, 255, 120))]
for r in json.load(open(f"{out}/results.json"))["rows"]:
    d = r.get("draw")
    if not d:
        continue
    xs = [p[0] for p in d["plot"]]; ys = [p[1] for p in d["plot"]]
    minx, miny, maxx, maxy = min(xs) - 8, min(ys) - 8, max(xs) + 8, max(ys) + 8
    w = min(1600, round((maxx - minx) / 0.08)); h = min(1600, round((maxy - miny) / 0.08))
    q = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": "Actueel_orthoHR", "STYLES": "",
         "CRS": "EPSG:28992", "BBOX": f"{minx},{miny},{maxx},{maxy}", "WIDTH": w, "HEIGHT": h, "FORMAT": "image/jpeg"}
    try:
        img = Image.open(io.BytesIO(urllib.request.urlopen(f"{WMS}?{urllib.parse.urlencode(q)}", timeout=60).read())).convert("RGBA")
    except Exception as e:
        print("photo failed", r["address"], e); continue
    px = lambda x, y: ((x - minx) / (maxx - minx) * w, (maxy - y) / (maxy - miny) * h)
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0)); dr = ImageDraw.Draw(ov)
    half = d["res"] / 2
    for x, y, hh in d["cells"]:
        col = next((c for t, c in COLS if hh >= t), None)
        if col:
            a = px(x - half, y + half); b = px(x + half, y - half)
            dr.rectangle([a, b], fill=col)
    img = Image.alpha_composite(img, ov).convert("RGB"); dr = ImageDraw.Draw(img)
    ring = lambda poly: [px(*p) for p in poly] + [px(*poly[0])]
    for poly in d["structures"]: dr.line(ring(poly), fill=(0, 230, 255), width=3)
    for poly in d["outbuildings"]: dr.line(ring(poly), fill=(200, 170, 255), width=3)
    for poly in d["house"]: dr.line(ring(poly), fill=(140, 110, 255), width=4)
    dr.line(ring(d["plot"]), fill=(255, 255, 255), width=4)
    dr.rectangle([0, 0, w, 34], fill=(0, 0, 0))
    a = r.get("areaAboveM2") or {}
    dr.text((8, 10), f"{r['address']}  garden {r.get('yardM2')} m2  >=1.0: {a.get('1')} | >=1.5: {a.get('1.5')} | >=2.0: {a.get('2')} | >=2.5: {a.get('2.5')} m2", fill=(255, 255, 255))
    if max(w, h) > 1100: img.thumbnail((1100, 1100))
    img.save(f"{out}/{re.sub(r'[^a-z0-9]+', '-', r['address'].lower()).strip('-')}.jpg", quality=82)
    print("drew", r["address"])
