"""Turn raw photos into the site's images and data entries.

    python tools/process_photos.py            process raw/ (only photos not seen before)
    python tools/process_photos.py --force    redo the images for every photo in raw/

For each JPEG in raw/:
  - reads the capture date (the only thing kept from the original's metadata)
  - writes docs/img/photos/thumb/<id>.webp (400px square) and med/<id>.webp (1600px long edge)
    with NO metadata at all: no EXIF, no GPS, no XMP, no colour profile (colours are converted to sRGB)
  - adds an entry to data/photos.json: id, flower (blank), date, alt (blank), width, height, source

Entries you have edited (flower names, alt text) are kept on re-runs. "source" is a short hash of the
original file, so the same photo is never added twice, even if it is renamed; the filename is not stored.
raw/ is read, never written. Placeholder photos are removed once real ones exist.
"""
import argparse
import hashlib
import io
import json
import sys
from datetime import datetime
from pathlib import Path

from PIL import ExifTags, Image, ImageCms, ImageOps

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
PHOTOS = ROOT / "docs" / "img" / "photos"
DATA = ROOT / "data" / "photos.json"

THUMB = 400
MEDIUM = 1600
SRGB = ImageCms.createProfile("sRGB")


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def capture_date(im):
    """ISO date the photo was taken, from EXIF DateTimeOriginal (or DateTime), or None."""
    exif = im.getexif()
    raw = exif.get_ifd(ExifTags.IFD.Exif).get(ExifTags.Base.DateTimeOriginal) or exif.get(ExifTags.Base.DateTime)
    try:
        return datetime.strptime(str(raw).strip()[:19], "%Y:%m:%d %H:%M:%S").date().isoformat()
    except (TypeError, ValueError):
        return None


def clean_pixels(im):
    """Upright, sRGB, RGB pixels in a brand-new image, so nothing from the original's metadata can tag along."""
    im = ImageOps.exif_transpose(im)
    icc = im.info.get("icc_profile")
    if icc:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        if "srgb" not in ImageCms.getProfileDescription(src).lower():
            im = ImageCms.profileToProfile(im, src, SRGB, outputMode="RGB")
    im = im.convert("RGB")
    fresh = Image.new("RGB", im.size)
    fresh.paste(im)
    return fresh


def save_webp(im, path, quality):
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "WEBP", quality=quality, method=6)
    with Image.open(path) as check:  # belt and braces: refuse to leave a file with metadata in it
        leaked = [k for k in ("exif", "xmp", "icc_profile") if check.info.get(k)] + (["exif"] if len(check.getexif()) else [])
        if leaked:
            path.unlink()
            sys.exit(f"stopped: {path.name} still had {', '.join(leaked)} after saving")


def process(src, pid):
    with Image.open(src) as original:
        date = capture_date(original)
        im = clean_pixels(original)

    med = im.copy()
    med.thumbnail((MEDIUM, MEDIUM), Image.LANCZOS)
    save_webp(med, PHOTOS / "med" / f"{pid}.webp", quality=78)

    square = ImageOps.fit(im, (THUMB, THUMB), Image.LANCZOS)
    save_webp(square, PHOTOS / "thumb" / f"{pid}.webp", quality=74)
    return date, med.size


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=RAW, help="folder of original photos (default: raw/)")
    ap.add_argument("--force", action="store_true", help="re-make images for photos already processed")
    args = ap.parse_args()

    sources = sorted(p for p in args.raw.iterdir() if p.suffix.lower() in (".jpg", ".jpeg")) if args.raw.is_dir() else []
    if not sources:
        sys.exit(f"no .jpg files in {args.raw}")

    entries = json.loads(DATA.read_text("utf-8"))["photos"] if DATA.exists() else []
    real = [e for e in entries if not e.get("placeholder")]
    by_source = {e["source"]: e for e in real if e.get("source")}

    # Hash and date everything first, so new photos are numbered in the order they were taken.
    found = []
    for src in sources:
        with Image.open(src) as im:
            found.append((capture_date(im) or "9999", src.name, src, file_hash(src)))
    found.sort()

    next_no = max((int(e["id"]) for e in real if e["id"].isdigit()), default=0) + 1
    added = redone = 0
    for _, name, src, h in found:
        entry = by_source.get(h)
        if entry and not args.force:
            continue
        if entry is None:
            entry = {"id": f"{next_no:04d}", "flower": "", "date": None, "alt": "", "source": h}
            next_no += 1
            real.append(entry)
            by_source[h] = entry
            added += 1
        else:
            redone += 1
        date, (w, h_px) = process(src, entry["id"])
        entry.update(date=date, width=w, height=h_px)
        print(f"  {entry['id']}  {date or 'undated'}  <- {name}")

    # Placeholders go once there is something real to show.
    placeholders = [e for e in entries if e.get("placeholder")]
    if real and placeholders:
        for e in placeholders:
            for size in ("thumb", "med"):
                (PHOTOS / size / f"{e['id']}.webp").unlink(missing_ok=True)
        print(f"removed {len(placeholders)} placeholder photos")

    real.sort(key=lambda e: (e.get("date") or "9999", e["id"]))
    DATA.parent.mkdir(exist_ok=True)
    DATA.write_text(json.dumps({"photos": real}, indent=2) + "\n", "utf-8")
    undated = sum(1 for e in real if not e.get("date"))
    print(f"{added} added, {redone} redone, {len(real)} photos in data/photos.json"
          + (f" ({undated} undated: no capture date in the file)" if undated else ""))


if __name__ == "__main__":
    main()
