"""Build aaryans.page into docs/.

    python build.py            build the site
    python build.py --serve    build, then serve docs/ at http://localhost:8000

Pages come from:
    /            content/about.md
    /blog/       content/posts/*.md        (one file per post)
    /flowers/    content/flowers.md + data/photos.json

Markdown files may start with a TOML block between +++ lines (title, date, category, ...).
docs/img/ and docs/CNAME are never touched by the build.
"""
import argparse
import hashlib
import html
import json
import math
import random
import re
import shutil
import tomllib
from datetime import date
from pathlib import Path

import markdown

import cards

ROOT = Path(__file__).resolve().parent
CONTENT = ROOT / "content"
STATIC = ROOT / "static"
PHOTOS_JSON = ROOT / "data" / "photos.json"
OUT = ROOT / "docs"
GENERATED = ["index.html", "404.html", "blog", "flowers", "assets", "og"]  # wiped and rebuilt every time

# Runs before first paint so paper mode doesn't flash dark: saved choice, else the system setting.
THEME_INIT = ('(function(){var t;try{t=localStorage.getItem("theme")}catch(e){}'
              't=t||(matchMedia("(prefers-color-scheme: light)").matches?"paper":"night");'
              'document.documentElement.dataset.theme=t})()')
THEME_ICON = ('<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">'
              '<circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'
              '<path d="M10 2.5a7.5 7.5 0 0 1 0 15z" fill="currentColor"/></svg>')

esc = html.escape
PLACEHOLDER = re.compile(r"\[(?:PLACEHOLDER|TK)\b[^\]]*\]")


# ---------- text helpers ----------

def mark(text):
    """Make [PLACEHOLDER ...] markers visible."""
    return PLACEHOLDER.sub(lambda m: f'<span class="ph">{m.group(0)}</span>', text)


def render(md_text):
    return mark(markdown.markdown(md_text, extensions=["extra", "sane_lists", "smarty"]))


def read_md(path):
    """(front matter dict, markdown body)."""
    text = path.read_text("utf-8")
    m = re.match(r"\+\+\+[ \t]*\r?\n(.*?)\r?\n\+\+\+[ \t]*\r?\n", text, re.S)
    if not m:
        return {}, text
    return tomllib.loads(m.group(1)), text[m.end():]


def as_date(value):
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)) if value else None


def long_date(d):
    return f"{d.day} {d:%B %Y}" if d else "undated"


def plain(html_text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html_text)).strip()


def summary(html_text, limit=200):
    """First paragraph as plain text, cut at a word boundary: the blurb shown under shared links."""
    m = re.search(r"<p>(.*?)</p>", html_text, re.S)
    text = html.unescape(plain(m.group(1) if m else html_text))
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(".,;:") + "…"


def sketch(key, strokes, *, cls, view, dots=(), freq=0.12, extra=""):
    """Pen strokes as inline SVG, in the same hand as the flight path (static/js/flight.js).

    Each stroke is (points, width, opacity, drift[, class]): it bends sideways along smooth noise by up to `drift`, and comes in
    three versions that differ by a fraction of that. The CSS shows them in turn, so the line "boils" like old
    hand-drawn animation. Seeded by `key`, so a rebuild draws the same thing.
    """
    rng = random.Random(key)

    def wave(amp):
        f1, f2 = rng.uniform(0.6, 1.4) * freq, rng.uniform(2, 3.5) * freq
        p1, p2 = rng.uniform(0, 6.3), rng.uniform(0, 6.3)
        return lambda d: amp * (0.7 * math.sin(d * f1 + p1) + 0.3 * math.sin(d * f2 + p2))

    def dense(pts, step=2):
        out = [pts[0]]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / step))
            out += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(1, n + 1)]
        return out

    lines = []
    for pts, width, opacity, drift, *tag in strokes:
        pts = dense(pts)
        along = [0.0]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            along.append(along[-1] + math.hypot(x1 - x0, y1 - y0))
        normals = []
        for i in range(len(pts)):
            (x0, y0), (x1, y1) = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
            l = math.hypot(x1 - x0, y1 - y0) or 1
            normals.append((-(y1 - y0) / l, (x1 - x0) / l))
        lines.append((pts, along, normals, width, opacity, wave(drift), drift * 0.55, tag))

    groups = []
    for _ in range(3):
        paths = []
        for pts, along, normals, width, opacity, base, boil, tag in lines:
            w = wave(boil)
            d = " ".join(f"{x + nx * o:.2f},{y + ny * o:.2f}" for (x, y), (nx, ny), o in
                         ((p, n, base(s) + w(s)) for p, n, s in zip(pts, normals, along)))
            paths.append(f'<path d="M{d}" stroke-width="{width}"{f' opacity="{opacity}"' if opacity < 1 else ''}'
                         f'{f' class="{tag[0]}"' if tag else ''}/>')
        for x, y, r in dots:
            paths.append(f'<circle cx="{x + rng.uniform(-.3, .3):.2f}" cy="{y + rng.uniform(-.3, .3):.2f}" r="{r}"/>')
        groups.append(f"<g>{''.join(paths)}</g>")
    return (f'<svg class="boil {cls}" viewBox="{view}"{extra} aria-hidden="true" focusable="false">'
            f'{"".join(groups)}</svg>')


def corner(key, flip=False):
    """An L of two pen strokes that cross where they meet, with an ink dot on the crossing; `flip` turns it round."""
    rng = random.Random(key)
    j = lambda: rng.uniform(-0.6, 0.6)
    down = [(3 + j(), 34), (2.6 + j(), 16), (2.2, -2.5)]
    across = [(-2.5, 2.6), (16, 2.2 + j()), (34, 3 + j())]
    again = ([(4.4, 27), (3.8, 7)] if rng.random() < 0.5 else [(8, 4.4), (27, 4)])  # gone over once more, faintly
    strokes = [(down, 1.3, 1, 0.7), (across, 1.3, 1, 0.7), (again, 0.8, 0.5, 0.6)]
    dots = [(2.4, 2.4, 1.7)]
    if flip:
        turn = lambda pts: [(40 - x, 40 - y) for x, y in pts]
        strokes = [(turn(p), *rest) for p, *rest in strokes]
        dots = [(40 - x, 40 - y, r) for x, y, r in dots]
    return sketch(key, strokes, cls="corner corner--" + ("br" if flip else "tl"), view="0 0 40 40", dots=dots)


def crane():
    """A tower crane drawn as a constellation: stars at the joints, pen lines between, holding a gold star on its hook.

    Two drawings in one box (260x230): the crane, and the hook on its cable, which the CSS swings from the trolley.
    """
    zig = lambda xs, y0, y1: [(x, y0 if i % 2 == 0 else y1) for i, x in enumerate(xs)]
    frame = [
        ([(96, 217), (96, 57)], 1.2, 1, 0.7),                       # mast
        ([(112, 217), (112, 57)], 1.2, 1, 0.7),
        ([(96 if i % 2 == 0 else 112, 217 - i * 26) for i in range(7)], 0.8, 0.6, 0.5),  # mast bracing
        ([(96, 57), (104, 22), (112, 57)], 1.2, 1, 0.7),            # the peak
        ([(38, 58), (248, 58)], 1.2, 1, 0.8),                        # jib and counter-jib
        (zig([112, 130, 150, 170, 190, 210, 230], 58, 50), 0.8, 0.6, 0.5),  # jib lattice
        ([(104, 22), (248, 58)], 0.9, 0.75, 0.9),                    # ties from the peak
        ([(104, 22), (38, 58)], 0.9, 0.75, 0.9),
        ([(44, 58), (44, 75), (66, 75), (66, 58)], 1.1, 1, 0.5),     # counterweight
        ([(112, 60), (112, 73), (127, 73), (127, 60)], 1.1, 1, 0.5),  # cab
        ([(68, 217), (142, 217)], 1, 0.6, 0.6),                      # ground
    ]
    joints = [(104, 22, 2.6), (248, 58, 2.3), (38, 58, 2.1), (96, 57, 1.6), (112, 57, 1.6),
              (96, 217, 1.9), (112, 217, 1.9), (196, 60, 1.9), (55, 66, 1.3)]
    body = sketch("crane", frame, cls="crane-frame", view="0 0 260 230", dots=joints)

    # the hook: cable down from the trolley, a J, and a gold sparkle caught in it
    tips = [(190, 141), (199, 150), (190, 159), (181, 150), (190, 141)]
    star = [tips[0]]
    for (ax, ay), (bx, by) in zip(tips, tips[1:]):
        cx, cy = 190 + (ax + bx - 380) * 0.1, 150 + (ay + by - 300) * 0.1  # sides pulled in towards the middle
        star += [((1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t * t * bx,
                  (1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t * t * by) for t in (i / 6 for i in range(1, 7))]
    hook = sketch("crane-hook", [
        ([(196, 61), (196, 128)], 0.9, 0.8, 0.5),
        ([(196, 128), (196, 135), (194.5, 139), (190.5, 141), (186.5, 139.5), (184.5, 135.5)], 1.3, 1, 0.3),
        (star, 1.2, 1, 0.3, "gold"),
    ], cls="crane-hook", view="0 0 260 230", dots=[(196, 128, 1.5)], freq=0.2)
    return f'<div class="crane" data-clear>{body}{hook}</div>'  # data-clear: flight.js keeps its path off it


def underline(key):
    """A pen underline that stretches to the word: drawn in a 100x6 box, scaled to fit with the stroke width kept."""
    rng = random.Random(key)
    main = [(-1, 3.4 + rng.uniform(-.4, .4)), (50, 3 + rng.uniform(-.4, .4)), (101, 2.6 + rng.uniform(-.4, .4))]
    again = [(rng.uniform(4, 14), 4.3), (rng.uniform(60, 80), 3.8)]
    return sketch(key, [(main, 1.2, 1, 0.55), (again, 0.7, 0.5, 0.5)], cls="underline", view="0 0 100 6",
                  freq=0.06, extra=' preserveAspectRatio="none"')


# ---------- loading ----------

def load():
    site = tomllib.loads((CONTENT / "site.toml").read_text("utf-8"))
    cats = {c["key"]: c for c in site.get("categories", [])}

    posts = []
    for f in sorted((CONTENT / "posts").glob("*.md")):
        meta, body = read_md(f)
        if meta.get("draft"):
            continue
        cat = meta.get("category", "")
        if cat not in cats:
            print(f"warning: {f.name}: category {cat!r} is not in site.toml")
        posts.append({
            "slug": re.sub(r"^\d{4}-\d{2}-\d{2}-", "", f.stem),
            "title": meta.get("title") or f.stem,
            "date": as_date(meta.get("date")),
            "category": cats.get(cat, {"key": cat or "other", "label": cat or "other", "colour": "#33322b"}),
            "photo": meta.get("photo"),
            "description": meta.get("description"),
            "html": render(body),
        })
    posts.sort(key=lambda p: (p["date"] or date.min, p["slug"]), reverse=True)

    photos = json.loads(PHOTOS_JSON.read_text("utf-8"))["photos"] if PHOTOS_JSON.exists() else []
    for p in photos:
        p["date"] = as_date(p.get("date"))
    photos.sort(key=lambda p: (p["date"] or date.max, p["id"]), reverse=True)  # newest first

    about = read_md(CONTENT / "about.md")
    flowers_md = CONTENT / "flowers.md"
    flowers_intro = render(flowers_md.read_text("utf-8")) if flowers_md.exists() else ""
    building_md = CONTENT / "building.md"
    building = render(building_md.read_text("utf-8")) if building_md.exists() else "<h2>you're early!</h2>"
    return site, about, posts, photos, flowers_intro, building


# ---------- pages ----------

class Builder:
    def __init__(self, site, about, posts, photos, flowers_intro, building):
        self.site, self.about, self.posts, self.photos, self.flowers_intro = site, about, posts, photos, flowers_intro
        self.building_html = building
        self.closed = set(site.get("building", []))  # sections showing the under-construction page
        for s in self.closed - {"blog", "flowers"}:
            print(f"warning: site.toml: building = {s!r} isn't a section that can be closed (blog, flowers)")
        self.photo_by_id = {p["id"]: p for p in photos}
        self.css_v = hashlib.md5((STATIC / "css" / "site.css").read_bytes()).hexdigest()[:8]
        self.js_v = hashlib.md5((STATIC / "js" / "site.js").read_bytes()).hexdigest()[:8]
        self.flight_v = hashlib.md5((STATIC / "js" / "flight.js").read_bytes()).hexdigest()[:8]
        self.icon_v = hashlib.md5((STATIC / "img" / "favicon.svg").read_bytes()).hexdigest()[:8]

    def butterfly(self, key, cls=""):
        """Drawing, angle and flip are fixed per key, so rebuilds don't shuffle them."""
        r = random.Random(key)
        style = (f"--bf:url({r.choice(self.site['butterflies'])});--rot:{r.randint(-25, 25)}deg;"
                 f"--flip:{r.choice([1, -1])}")
        return f'<span class="bfly {cls}" style="{style}" aria-hidden="true"><i></i></span>'

    @staticmethod
    def alt(p):
        if p.get("alt"):
            return p["alt"]
        return f"{p.get('flower') or 'A flower'}, photographed {long_date(p['date'])}"

    @staticmethod
    def caption(p):
        name = f"{esc(p['flower'])} &middot; " if p.get("flower") else ""
        note = " &middot; placeholder image" if p.get("placeholder") else ""
        return f"{name}Photographed {long_date(p['date'])}{note}"

    def img(self, p, size, *, eager=False, alt=None):
        w, h = (400, 400) if size == "thumb" else (p.get("width", 1600), p.get("height", 1200))
        lazy = "" if eager else ' loading="lazy"'
        return (f'<img src="/img/photos/{size}/{p["id"]}.webp" width="{w}" height="{h}" '
                f'alt="{esc(self.alt(p) if alt is None else alt)}" decoding="async"{lazy}>')

    def nearest_photo(self, post):
        """The post's chosen photo, else the one taken closest to its date."""
        if post["photo"] in self.photo_by_id:
            return self.photo_by_id[post["photo"]]
        dated = [p for p in self.photos if p["date"]]
        if not dated:
            return self.photos[0] if self.photos else None
        if not post["date"]:
            return dated[0]
        return min(dated, key=lambda p: (abs((p["date"] - post["date"]).days), p["id"]))

    def page(self, *, title, body, section, path, description=None, wide=False, card=None, card_alt=None, article=False):
        """path: this page's URL path. card: URL path of its preview image."""
        s = self.site
        nav = "".join(
            f'<a href="{href}" aria-current="page">{key}{underline("nav-" + key)}</a>' if key == section
            else f'<a href="{href}">{key}</a>'
            for key, href in [("about", "/"), ("blog", "/blog/"), ("flowers", "/flowers/")])
        links = "".join(f'<a href="{esc(l["href"])}">{esc(l["label"])}</a>' for l in s.get("links", []))
        full_title = s["title"] if title is None else f"{title} | {s['title']}"
        desc = esc(plain(description or s["description"]))
        base = s["url"].rstrip("/")
        social = f"""<link rel="canonical" href="{base}{path}">
<meta property="og:site_name" content="{esc(s['title'])}">
<meta property="og:type" content="{'article' if article else 'website'}">
<meta property="og:title" content="{esc(title or s['name'])}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{base}{path}">"""
        if card:
            social += f"""
<meta property="og:image" content="{base}{card}">
<meta property="og:image:alt" content="{esc(card_alt or title or s['name'])}">
<meta name="twitter:card" content="summary_large_image">"""
        return f"""<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(full_title)}</title>
<meta name="description" content="{desc}">
{social}
<meta name="theme-color" content="#11110e">
<meta name="color-scheme" content="dark light">
<meta name="darkreader-lock">
<script>{THEME_INIT}</script>
<link rel="icon" href="/assets/img/favicon.svg?v={self.icon_v}" type="image/svg+xml">
<link rel="stylesheet" href="/assets/css/site.css?v={self.css_v}">
<script src="/assets/js/site.js?v={self.js_v}" defer></script>
<script src="/assets/js/flight.js?v={self.flight_v}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="name" href="/">{esc(s['name'])}{self.butterfly("name", "bfly--name")}</a>
  <nav class="nav" aria-label="Main">{nav}</nav>
  <div class="right">
    <div class="elsewhere">{links}</div>
    <button class="theme" type="button" aria-label="switch theme" hidden>{THEME_ICON}</button>
  </div>
</header>
<main id="main" class="page{' page--wide' if wide else ''}">
{body}
</main>
<footer class="foot{' foot--wide' if wide else ''}">
  <span>&copy; {date.today().year} {esc(s['title'])}</span>{links}
</footer>
</body>
</html>
"""

    def home(self):
        meta, body = self.about
        p = self.photo_by_id.get(meta.get("photo", ""))
        link = "" if "flowers" in self.closed else f' href="/flowers/{p["id"]}/"'
        figure = (f'<figure class="about-photo"><a{link}>{self.img(p, "med", eager=True)}'
                  f'{corner("about-tl")}{corner("about-br", flip=True)}</a>'
                  f'<figcaption>{self.caption(p)}</figcaption></figure>') if p else ""
        return self.page(title=None, section="about", wide=bool(p), path="/", card="/og/about.jpg",
                         body=f'<div class="about{" about--photo" if p else ""}"><div class="prose">{render(body)}</div>{figure}</div>')

    def blog(self):
        counts = {}
        for p in self.posts:
            counts[p["category"]["key"]] = counts.get(p["category"]["key"], 0) + 1
        cats = self.site.get("categories", [])
        legend = "".join(
            f'<li><button type="button" data-cat="{esc(c["key"])}" aria-pressed="false" style="--c:{c["colour"]}">'
            f'<span class="swatch"></span>{esc(c["label"])} <span class="n">{counts.get(c["key"], 0)}</span></button></li>'
            for c in cats)
        rows = "".join(
            f'<li data-cat="{esc(p["category"]["key"])}" style="--c:{p["category"]["colour"]}">'
            f'<time datetime="{p["date"] or ""}">{p["date"] or "undated"}</time>'
            f'<a href="/blog/{p["slug"]}/">{mark(esc(p["title"]))}</a></li>'
            for p in self.posts)
        body = f"""<div class="blog">
  <ul class="legend" aria-label="Legend: click to filter">{legend}</ul>
  <ul class="posts">{rows or '<li class="dim">nothing yet.</li>'}</ul>
</div>"""
        return self.page(title="blog", section="blog", body=body, wide=True, path="/blog/", card="/og/blog.jpg")

    def post(self, p):
        c = p["category"]
        body = f"""<article>
  <header class="post-head">
    <h1>{mark(esc(p['title']))}</h1>
    <div class="post-meta"><time datetime="{p['date'] or ''}">{long_date(p['date'])}</time><span class="tag" style="--c:{c['colour']}"><span class="swatch"></span>{esc(c['label'])}</span></div>
  </header>
  <div class="prose">{p['html']}</div>
</article>
<p class="back"><a href="/blog/">&larr; all writing</a></p>"""
        return self.page(title=plain(p["title"]), section="blog", body=body, description=p["description"] or summary(p["html"]),
                         path=f"/blog/{p['slug']}/", card=f"/og/{p['slug']}.jpg", article=True)

    def flowers(self):
        cells = []
        for i, p in enumerate(self.photos):
            perch = self.butterfly("perch", "bfly--perch") if i == 0 else ""
            cells.append(f'<a href="/flowers/{p["id"]}/">{self.img(p, "thumb", eager=i < 8)}{perch}</a>')
        intro = f'<div class="prose intro">{self.flowers_intro}</div>' if self.flowers_intro else ""
        grid = f'<div class="flowers">{"".join(cells)}</div>' if cells else '<p class="dim">no photos yet.</p>'
        return self.page(title="flowers", section="flowers", body=intro + grid, wide=True,
                         path="/flowers/", card="/og/flowers.jpg")

    def specimen(self, i):
        p = self.photos[i]
        newer = self.photos[i - 1] if i > 0 else None
        older = self.photos[i + 1] if i + 1 < len(self.photos) else None
        pager = ('<span>' + (f'<a href="/flowers/{newer["id"]}/">&larr; newer</a>' if newer else "") + '</span>'
                 '<a href="/flowers/">all flowers</a>'
                 '<span>' + (f'<a href="/flowers/{older["id"]}/">older &rarr;</a>' if older else "") + '</span>')
        body = f"""<figure class="specimen">
  {self.img(p, "med", eager=True)}
  <figcaption>No. {esc(p['id'])} &middot; {self.caption(p)}</figcaption>
</figure>
<nav class="pager" aria-label="Photos">{pager}</nav>"""
        # a photo page shares the photo itself rather than a drawn card
        return self.page(title=p.get("flower") or f"flower {p['id']}", section="flowers", body=body, description=self.alt(p),
                         path=f"/flowers/{p['id']}/", card=f"/img/photos/med/{p['id']}.webp", card_alt=self.alt(p))

    def under_construction(self, section):
        body = f'<div class="building">{crane()}<div class="prose">{self.building_html}</div></div>'
        return self.page(title=section, section=section, body=body, path=f"/{section}/", card=f"/og/{section}.jpg")

    def not_found(self):
        body = '<div class="prose"><p>nothing is filed at this address.</p><p><a href="/">back to the start</a></p></div>'
        return self.page(title="not found", section=None, body=body, path="/404.html")

    def cards(self):
        """Draw the preview images referenced by page(card=...)."""
        og = OUT / "og"
        med = lambda p: OUT / "img" / "photos" / "med" / f"{p['id']}.webp" if p else None
        about_photo = self.photo_by_id.get(self.about[0].get("photo", ""))
        newest = self.photos[0] if self.photos else None
        n_posts, n_photos = len(self.posts), len(self.photos)
        cards.card(og / "about.jpg", title=self.site["name"], footer="about · blog · flowers", photo=med(about_photo or newest))
        soon = "under construction"
        cards.card(og / "blog.jpg", title="blog", photo=med(newest),
                   footer=soon if "blog" in self.closed else f"{n_posts} post{'s' * (n_posts != 1)}")
        cards.card(og / "flowers.jpg", title="flowers", photo=med(newest),
                   footer=soon if "flowers" in self.closed else f"{n_photos} photograph{'s' * (n_photos != 1)}")
        for p in [] if "blog" in self.closed else self.posts:
            footer = f"{p['category']['label']} · {long_date(p['date'])}"
            cards.card(og / f"{p['slug']}.jpg", title=plain(p["title"]), footer=footer,
                       photo=med(self.nearest_photo(p)), swatch=p["category"]["colour"])


# ---------- build ----------

def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, "utf-8", newline="\n")


def build():
    b = Builder(*load())

    for name in GENERATED:
        target = OUT / name
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
    shutil.copytree(STATIC, OUT / "assets")
    (OUT / ".nojekyll").touch()

    write(OUT / "index.html", b.home())
    write(OUT / "404.html", b.not_found())
    # a closed section gets the under-construction page in place of its index, and none of its inner pages
    if "blog" in b.closed:
        write(OUT / "blog" / "index.html", b.under_construction("blog"))
    else:
        write(OUT / "blog" / "index.html", b.blog())
        for p in b.posts:
            write(OUT / "blog" / p["slug"] / "index.html", b.post(p))
    if "flowers" in b.closed:
        write(OUT / "flowers" / "index.html", b.under_construction("flowers"))
    else:
        write(OUT / "flowers" / "index.html", b.flowers())
        for i, p in enumerate(b.photos):
            write(OUT / "flowers" / p["id"] / "index.html", b.specimen(i))
    b.cards()

    missing = [p["id"] for p in b.photos if not (OUT / "img" / "photos" / "thumb" / f"{p['id']}.webp").exists()]
    if missing:
        print(f"warning: no image files for {', '.join(missing)}")
    closed = f" (under construction: {', '.join(sorted(b.closed))})" if b.closed else ""
    print(f"built {len(b.posts)} posts, {len(b.photos)} photos -> {OUT.relative_to(ROOT)}/{closed}")


def serve(port=8000):
    import functools
    import http.server
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving http://localhost:{port}/  (ctrl+c to stop)")
        httpd.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--serve", action="store_true", help="serve docs/ after building")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    build()
    if args.serve:
        serve(args.port)
