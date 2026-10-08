"""The invented demo session: a Claude Code transcript (JSONL) and the images pasted into it.

    python demo/fixture.py        # writes demo/fixture/session.jsonl and demo/fixture/images/*.png

Everything here is made up: the project (an orders API in C:\\Users\\alice\\code\\api), the conversation, the
links (example.com hosts and two public docs pages) and the pictures, which are drawn below with PIL (charts, a
whiteboard sketch, a UI mock, a JSON viewer). Same input, same bytes: fixed ids, fixed clock, no metadata.
"""

import base64
import io
import json
import math
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixture"
IMAGES = OUT / "images"

SESSION = "5d1c9a6e-2f43-4b8e-9a71-3c0e8d4f2b16"
CWD = "C:\\Users\\alice\\code\\api"
ROOT = CWD
T0 = datetime(2026, 10, 6, 12, 2, 11, tzinfo=timezone.utc)   # 14:02 in Europe/Rome

# ── Fonts (Windows first, then common Linux/macOS names, then PIL's own) ──────────
FONT_DIRS = [Path("C:/Windows/Fonts"), Path.home() / "AppData/Local/Microsoft/Windows/Fonts",
             Path("/usr/share/fonts"), Path("/Library/Fonts"), Path.home() / ".local/share/fonts"]


def find_font(*names):
    for d in FONT_DIRS:
        if not d.exists():
            continue
        for n in names:
            hits = list(d.rglob(n))
            if hits:
                return str(hits[0])
    return None


SANS = find_font("segoeui.ttf", "Inter-Regular.ttf", "DejaVuSans.ttf")
SANS_SB = find_font("seguisb.ttf", "segoeuib.ttf", "Inter-SemiBold.ttf", "DejaVuSans-Bold.ttf")
MONO = find_font("CascadiaMono.ttf", "JetBrainsMonoNerdFontMono-Regular.ttf", "JetBrainsMono-Regular.ttf", "DejaVuSansMono.ttf")


def font(path, size):
    return ImageFont.truetype(path, size) if path else ImageFont.load_default(size)


def sans(s):
    return font(SANS, s)


def sans_sb(s):
    return font(SANS_SB, s)


def mono(s):
    return font(MONO, s)


# ── The pictures ────────────────────────────────────────────────────────────────
INK = (17, 19, 24)
PANEL = (24, 27, 34)
GRID = (44, 48, 58)
TXT = (222, 225, 232)
MUTED = (140, 146, 160)
ACCENT = (139, 130, 255)      # the light tint of #5347fd that the window uses for text
WARN = (232, 150, 72)
OK = (88, 196, 140)


def chart(series, title, subtitle, yfmt, marker=None, band=None, colour=ACCENT, ymax=None, xlabels=None):
    """A dashboard panel: a smooth line with a soft fill, gridlines, labels, an optional vertical marker."""
    W, H, S = 1200, 680, 2                       # drawn at 2x and reduced, for clean lines
    img = Image.new("RGB", (W * S, H * S), INK)
    d = ImageDraw.Draw(img, "RGBA")
    d.rounded_rectangle((24 * S, 24 * S, (W - 24) * S, (H - 24) * S), radius=18 * S, fill=PANEL)
    d.text((60 * S, 62 * S), title, font=sans_sb(30 * S), fill=TXT, anchor="ls")
    d.text((60 * S, 96 * S), subtitle, font=sans(21 * S), fill=MUTED, anchor="ls")
    x0, x1, y0, y1 = 120, W - 64, 140, H - 92
    top = ymax or max(series) * 1.15
    for i in range(5):
        v = top * i / 4
        y = y1 - (y1 - y0) * i / 4
        d.line((x0 * S, y * S, x1 * S, y * S), fill=GRID, width=S)
        d.text(((x0 - 16) * S, y * S), yfmt(v), font=sans(18 * S), fill=MUTED, anchor="rm")
    n = len(series)
    pts = [((x0 + (x1 - x0) * i / (n - 1)) * S, (y1 - (y1 - y0) * v / top) * S) for i, v in enumerate(series)]
    if xlabels:
        for i, lab in enumerate(xlabels):
            x = x0 + (x1 - x0) * i / (len(xlabels) - 1)
            d.text((x * S, (y1 + 34) * S), lab, font=sans(18 * S), fill=MUTED, anchor="mm")
    if band:
        a, b, lab = band
        xa, xb = x0 + (x1 - x0) * a, x0 + (x1 - x0) * b
        d.rectangle((xa * S, y0 * S, xb * S, y1 * S), fill=(255, 255, 255, 10))
    # fill under the line
    fill = Image.new("L", img.size, 0)
    ImageDraw.Draw(fill).polygon(pts + [(pts[-1][0], y1 * S), (pts[0][0], y1 * S)], fill=70)
    grad = Image.linear_gradient("L").resize(img.size)
    fill = Image.composite(fill, Image.new("L", img.size, 0), grad.point(lambda g: 255 - g))
    img.paste(Image.new("RGB", img.size, colour), (0, 0), fill)
    d = ImageDraw.Draw(img, "RGBA")
    d.line(pts, fill=colour, width=4 * S, joint="curve")
    if marker:
        at, lab = marker
        xm = (x0 + (x1 - x0) * at) * S
        for yy in range(y0 * S, y1 * S, 14 * S):
            d.line((xm, yy, xm, yy + 7 * S), fill=(255, 255, 255, 120), width=2 * S)
        w = d.textlength(lab, font=sans_sb(18 * S)) + 28 * S
        d.rounded_rectangle((xm - w / 2, (y0 - 8) * S, xm + w / 2, (y0 + 26) * S), radius=17 * S, fill=(255, 255, 255, 235))
        d.text((xm, (y0 + 9) * S), lab, font=sans_sb(18 * S), fill=INK, anchor="mm")
    lx, ly = pts[-1]
    d.ellipse((lx - 9 * S, ly - 9 * S, lx + 9 * S, ly + 9 * S), fill=colour, outline=PANEL, width=3 * S)
    return img.resize((W, H), Image.LANCZOS)


def whiteboard():
    """A hand-drawn-looking sketch of cursor pagination on a light board."""
    W, H, S = 1200, 760, 2
    img = Image.new("RGB", (W * S, H * S), (246, 245, 240))
    d = ImageDraw.Draw(img, "RGBA")
    pen = (40, 44, 60)
    d.text((70 * S, 92 * S), "cursor = (created_at, id) of the last row", font=sans_sb(34 * S), fill=pen, anchor="ls")
    boxes = [(90, "page 1", ["#1043  10:02", "#1042  09:58", "#1041  09:51"]),
             (450, "page 2", ["#1040  09:47", "#1039  09:40", "#1038  09:33"]),
             (810, "page 3", ["#1037  09:31", "#1036  09:20", "end"])]
    for x, name, rows in boxes:
        d.rounded_rectangle((x * S, 170 * S, (x + 300) * S, 520 * S), radius=22 * S, outline=pen, width=4 * S)
        d.text(((x + 30) * S, 222 * S), name, font=sans_sb(30 * S), fill=pen, anchor="ls")
        for i, r in enumerate(rows):
            y = 290 + i * 70
            colour = (83, 71, 253) if (i == 2 and r != "end") else pen
            d.text(((x + 30) * S, y * S), r, font=mono(26 * S), fill=colour, anchor="ls")
            if r != "end":
                d.line(((x + 30) * S, (y + 18) * S, (x + 270) * S, (y + 18) * S), fill=(40, 44, 60, 40), width=2 * S)
    for x in (390, 750):
        d.line((x * S, 345 * S, (x + 60) * S, 345 * S), fill=(83, 71, 253), width=5 * S)
        d.polygon([((x + 60) * S, 333 * S), ((x + 78) * S, 345 * S), ((x + 60) * S, 357 * S)], fill=(83, 71, 253))
    d.text((90 * S, 610 * S), "?cursor=b3JkXzEwNDE  ->  WHERE (created_at, id) < (:t, :id)", font=mono(26 * S), fill=pen, anchor="ls")
    d.text((90 * S, 670 * S), "LIMIT :limit + 1   (one extra row tells if there is a next page)", font=mono(26 * S), fill=(110, 114, 128), anchor="ls")
    img = img.resize((W, H), Image.LANCZOS)
    return img.filter(ImageFilter.GaussianBlur(0.35))


def ui_mock():
    """The web app's orders table with a Load more button (a light UI mock)."""
    W, H, S = 1200, 760, 2
    img = Image.new("RGB", (W * S, H * S), (238, 240, 245))
    d = ImageDraw.Draw(img, "RGBA")
    d.rounded_rectangle((40 * S, 40 * S, (W - 40) * S, (H - 40) * S), radius=20 * S, fill=(255, 255, 255))
    d.text((90 * S, 112 * S), "Orders", font=sans_sb(40 * S), fill=(24, 26, 32), anchor="ls")
    d.rounded_rectangle(((W - 330) * S, 76 * S, (W - 90) * S, 122 * S), radius=10 * S, outline=(210, 214, 222), width=2 * S)
    d.text(((W - 306) * S, 99 * S), "Search orders", font=sans(22 * S), fill=(150, 154, 166), anchor="lm")
    cols = [(90, "Order"), (300, "Customer"), (640, "Total"), (820, "Status")]
    for x, c in cols:
        d.text((x * S, 182 * S), c, font=sans_sb(21 * S), fill=(120, 124, 136), anchor="ls")
    rows = [("#1043", "Harbor & Pine", "$1,240.00", "Paid"), ("#1042", "Lumen Studio", "$86.50", "Paid"),
            ("#1041", "Northwind Café", "$412.90", "Pending"), ("#1040", "Atlas Outdoor", "$2,015.00", "Paid"),
            ("#1039", "Bright Paper Co.", "$57.20", "Refunded")]
    tone = {"Paid": ((226, 246, 234), (30, 130, 80)), "Pending": ((254, 241, 224), (176, 98, 20)), "Refunded": ((236, 238, 243), (96, 100, 114))}
    for i, (a, b, c, s) in enumerate(rows):
        y = 240 + i * 74
        d.line((90 * S, (y - 34) * S, (W - 90) * S, (y - 34) * S), fill=(232, 234, 240), width=2 * S)
        d.text((90 * S, y * S), a, font=mono(23 * S), fill=(24, 26, 32), anchor="ls")
        d.text((300 * S, y * S), b, font=sans(23 * S), fill=(24, 26, 32), anchor="ls")
        d.text((640 * S, y * S), c, font=sans(23 * S), fill=(24, 26, 32), anchor="ls")
        bg, fg = tone[s]
        w = d.textlength(s, font=sans_sb(19 * S)) + 30 * S
        d.rounded_rectangle((820 * S, (y - 26) * S, 820 * S + w, (y + 6) * S), radius=16 * S, fill=bg)
        d.text((820 * S + w / 2, (y - 10) * S), s, font=sans_sb(19 * S), fill=fg, anchor="mm")
    bw = 220
    d.rounded_rectangle(((W / 2 - bw / 2) * S, 622 * S, (W / 2 + bw / 2) * S, 676 * S), radius=12 * S, fill=(83, 71, 253))
    d.text((W / 2 * S, 649 * S), "Load more", font=sans_sb(23 * S), fill=(255, 255, 255), anchor="mm")
    return img.resize((W, H), Image.LANCZOS)


def json_view():
    """A response viewer: status line and a pretty-printed JSON body."""
    W, H, S = 1200, 720, 2
    img = Image.new("RGB", (W * S, H * S), (22, 24, 30))
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle((0, 0, W * S, 70 * S), fill=(30, 33, 41))
    d.rounded_rectangle((30 * S, 18 * S, 110 * S, 52 * S), radius=8 * S, fill=(52, 120, 84))
    d.text((70 * S, 35 * S), "GET", font=sans_sb(20 * S), fill=(230, 255, 240), anchor="mm")
    d.text((130 * S, 35 * S), "https://staging.example.com/v1/orders?limit=3&cursor=b3JkXzEwNDE", font=mono(21 * S), fill=TXT, anchor="lm")
    d.text(((W - 40) * S, 35 * S), "200 OK  ·  38 ms", font=sans_sb(20 * S), fill=OK, anchor="rm")
    key, strc, num, pun = (139, 130, 255), (232, 190, 120), (120, 200, 230), (150, 156, 170)
    lines = [
        [("{", pun)],
        [('  "data"', key), (": [", pun)],
        [("    { ", pun), ('"id"', key), (": ", pun), ('"ord_1040"', strc), (", ", pun), ('"total"', key), (": ", pun), ("2015.00", num), (" },", pun)],
        [("    { ", pun), ('"id"', key), (": ", pun), ('"ord_1039"', strc), (", ", pun), ('"total"', key), (": ", pun), ("57.20", num), (" },", pun)],
        [("    { ", pun), ('"id"', key), (": ", pun), ('"ord_1038"', strc), (", ", pun), ('"total"', key), (": ", pun), ("318.75", num), (" }", pun)],
        [("  ],", pun)],
        [('  "limit"', key), (": ", pun), ("3", num), (",", pun)],
        [('  "next_cursor"', key), (": ", pun), ('"b3JkXzEwMzg"', strc)],
        [("}", pun)],
    ]
    f = mono(27 * S)
    for i, parts in enumerate(lines):
        x = 60 * S
        y = (140 + i * 54) * S
        d.text((24 * S, y), str(i + 1).rjust(2), font=mono(22 * S), fill=(80, 86, 100), anchor="ls")
        for txt, col in parts:
            d.text((x, y), txt, font=f, fill=col, anchor="ls")
            x += d.textlength(txt, font=f)
    return img.resize((W, H), Image.LANCZOS)


def load_test():
    """Bars: requests per second before and after, from a load test."""
    W, H, S = 1200, 680, 2
    img = Image.new("RGB", (W * S, H * S), INK)
    d = ImageDraw.Draw(img, "RGBA")
    d.rounded_rectangle((24 * S, 24 * S, (W - 24) * S, (H - 24) * S), radius=18 * S, fill=PANEL)
    d.text((60 * S, 62 * S), "Load test  ·  200 virtual users, 5 min", font=sans_sb(30 * S), fill=TXT, anchor="ls")
    d.text((60 * S, 96 * S), "GET /v1/orders on a 40k-order account", font=sans(21 * S), fill=MUTED, anchor="ls")
    groups = [("requests / s", 38, 910, 1000, lambda v: f"{v:,.0f}"), ("p95 ms", 1840, 118, 2000, lambda v: f"{v:,.0f}"), ("errors %", 4.1, 0.0, 5, lambda v: f"{v:.1f}")]
    base = H - 110
    for gi, (lab, a, b, top, fmt) in enumerate(groups):
        cx = 230 + gi * 360
        for j, (v, col, tag) in enumerate(((a, (96, 100, 116), "before"), (b, ACCENT, "after"))):
            x = cx - 70 + j * 90
            h = max(4, (base - 170) * v / top)
            d.rounded_rectangle((x * S, (base - h) * S, (x + 70) * S, base * S), radius=10 * S, fill=col)
            d.text(((x + 35) * S, (base - h - 16) * S), fmt(v), font=sans_sb(20 * S), fill=TXT, anchor="ms")
            d.text(((x + 35) * S, (base + 28) * S), tag, font=sans(17 * S), fill=MUTED, anchor="mm")
        d.text((cx * S, (base + 62) * S), lab, font=sans_sb(20 * S), fill=TXT, anchor="mm")
    return img.resize((W, H), Image.LANCZOS)


def latency_before():
    s = [0.42, 0.44, 0.47, 0.5, 0.55, 0.6, 0.66, 0.72, 0.8, 0.86, 0.95, 1.04, 1.1, 1.22, 1.3, 1.38, 1.47, 1.55, 1.62, 1.7, 1.76, 1.82]
    return chart(s, "p95 latency  ·  GET /v1/orders", "production, last 7 days", lambda v: f"{v:.1f} s", colour=WARN, ymax=2.0,
                 xlabels=["Sep 30", "Oct 1", "Oct 2", "Oct 3", "Oct 4", "Oct 5", "Oct 6"])


def latency_after():
    s = [1.71, 1.76, 1.8, 1.78, 1.83, 1.79, 1.81, 1.84, 1.8, 1.82, 0.62, 0.21, 0.14, 0.12, 0.125, 0.118, 0.121, 0.117, 0.12, 0.119, 0.122, 0.12]
    return chart(s, "p95 latency  ·  GET /v1/orders", "staging, last 6 hours", lambda v: f"{v:.1f} s", marker=(0.45, "deploy 2.4.0-rc.1"),
                 colour=ACCENT, ymax=2.0, xlabels=["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"])


PICTURES = {
    "latency-before": latency_before,
    "cursor-sketch": whiteboard,
    "orders-table": ui_mock,
    "staging-response": json_view,
    "load-test": load_test,
    "latency-after": latency_after,
}


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ── The conversation ────────────────────────────────────────────────────────────
def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"sidecr-demo/{name}"))


def ts(minutes, seconds=0):
    return (T0 + timedelta(minutes=minutes, seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def p(rel):
    return ROOT + "\\" + rel.replace("/", "\\")


EXCHANGES = [
    dict(at=0, image="latency-before",
         user="GET /v1/orders is getting slow on the big accounts, this is p95 for the last week. Can you find out why?",
         tools=[("Read", {"file_path": p("src/routes/orders.ts")}), ("Grep", {"pattern": "findMany", "path": p("src")}),
                ("Read", {"file_path": p("src/db/orders.ts")})],
         reply="Found it. `listOrders` loads **every** order of the account and sorts them in memory before slicing out the page, "
               "so the cost grows with the account, not with the page. The 40k-order accounts read about 30 MB per request.\n\n"
               "Two ways out:\n\n1. Offset pagination: small change, but deep pages still scan everything before them.\n"
               "2. Cursor pagination on `(created_at, id)`: every page is an index range, the same cost on page 1 and page 400.\n\n"
               "I would go with the cursor."),
    dict(at=7, image="cursor-sketch",
         user="Agreed, cursor it is. This is how I picture it. Keep limit capped at 100.",
         tools=[("Write", {"file_path": p("src/lib/cursor.ts")}), ("Edit", {"file_path": p("src/db/orders.ts")}),
                ("Edit", {"file_path": p("src/routes/orders.ts")}), ("Bash", {"command": "bun test test/orders.test.ts"})],
         reply="Done, and your sketch is exactly it. The cursor is the base64 of `created_at|id` of the last row, and I fetch "
               "`limit + 1` rows so the extra one says whether there is a next page.\n\n- `limit` defaults to 50, capped at 100\n"
               "- a bad or expired cursor answers `400 invalid_cursor`\n- 14 new tests, all 61 pass"),
    dict(at=15, image="orders-table",
         user="The web app should switch to a Load more button. Is the response shape enough for that?",
         tools=[("Read", {"file_path": p("src/routes/orders.ts")})],
         reply="Yes. The response is `{ data, limit, next_cursor }`; the button calls the same URL with `cursor=next_cursor` and "
               "disappears when `next_cursor` is `null`. The table never has to know the total."),
    dict(at=23, image="staging-response",
         user="Deployed to staging, here is a page from the middle. next_cursor looks right?",
         tools=[("Bash", {"command": "curl -s \"https://staging.example.com/v1/orders?limit=3&cursor=b3JkXzEwMzg\""})],
         reply="It is right: `b3JkXzEwMzg` decodes to the last row on that page, `ord_1038`, and the next request starts just "
               "after it. I also checked the last page of that account: `next_cursor` is `null` and `data` has the 2 leftover orders."),
    dict(at=31, image="load-test",
         user="Ran the load test against staging.",
         tools=[("Write", {"file_path": p("migrations/0042_orders_created_at_id.sql")}),
                ("Bash", {"command": "bun run db:migrate --dry-run"})],
         reply="That is the index doing its job: 24x the throughput and no more timeouts. I added the migration that creates it "
               "concurrently, so production does not lock the table:\n\n```sql\nCREATE INDEX CONCURRENTLY orders_account_created_id\n"
               "  ON orders (account_id, created_at DESC, id DESC);\n```\n\nSee https://www.postgresql.org/docs/current/indexes-multicolumn.html "
               "for why the column order matters."),
    dict(at=38, image="latency-after",
         user="And this is p95 on staging after the deploy.",
         tools=[],
         reply="From 1.8 s down to 120 ms, and flat: page 1 and page 400 now cost the same. "
               "Dashboard: https://metrics.example.com/d/orders-api"),
    dict(at=44, image=None,
         user="Great. Write the docs and a changelog entry, then I will open the PR.",
         tools=[("Write", {"file_path": p("docs/pagination.md")}), ("Edit", {"file_path": p("CHANGELOG.md")}),
                ("Edit", {"file_path": p("README.md")})],
         reply=(
             "Docs are written and the changelog has a **2.4.0** entry. A client walks the list like this:\n\n"
             "```ts\nlet cursor: string | undefined;\ndo {\n  const page = await orders.list({ cursor });\n"
             "  render(page.data);\n  cursor = page.next_cursor ?? undefined;\n} while (cursor);\n```\n\n"
             "- `limit` defaults to 50, at most 100\n"
             "- `next_cursor` is `null` on the last page\n\n"
             f"The guide is `{p('docs/pagination.md')}`, the route is in `{p('src/routes')}`. "
             "Reference: https://docs.example.com/api/pagination"
         )),
]


def rows():
    out = []
    parent = None
    for n, ex in enumerate(EXCHANGES):
        u = uid(f"user-{n}")
        content = [{"type": "text", "text": ex["user"]}]
        if ex["image"]:
            data = base64.b64encode(png_bytes(PICTURES[ex["image"]]())).decode("ascii")
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}})
        common = {"sessionId": SESSION, "cwd": CWD, "version": "2.4.1", "gitBranch": "feat/cursor-pagination", "userType": "external", "isSidechain": False}
        out.append({"parentUuid": parent, **common, "type": "user", "uuid": u, "timestamp": ts(ex["at"]), "promptSource": "user",
                    "message": {"role": "user", "content": content}})
        parent = u
        sec = 6
        for k, (name, inp) in enumerate(ex["tools"]):
            a = uid(f"tool-{n}-{k}")
            tid = "toolu_" + uid(f"toolid-{n}-{k}").replace("-", "")[:24]
            out.append({"parentUuid": parent, **common, "type": "assistant", "uuid": a, "timestamp": ts(ex["at"], sec),
                        "message": {"id": f"msg_demo_{n:02d}_{k:02d}", "role": "assistant", "model": "claude-opus-4-1",
                                    "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}],
                                    "usage": {"input_tokens": 1800 + 140 * k, "output_tokens": 90 + 12 * k}}})
            r = uid(f"result-{n}-{k}")
            out.append({"parentUuid": a, **common, "type": "user", "uuid": r, "timestamp": ts(ex["at"], sec + 2),
                        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}})
            parent = r
            sec += 9
        a = uid(f"reply-{n}")
        out.append({"parentUuid": parent, **common, "type": "assistant", "uuid": a, "timestamp": ts(ex["at"], sec + 4),
                    "message": {"id": f"msg_demo_{n:02d}_reply", "role": "assistant", "model": "claude-opus-4-1",
                                "content": [{"type": "text", "text": ex["reply"]}],
                                "usage": {"input_tokens": 2400 + 300 * n, "output_tokens": 220 + 30 * n}}})
        parent = a
    return out


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    for name, make in PICTURES.items():
        (IMAGES / f"{name}.png").write_bytes(png_bytes(make()))
    lines = [json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows()]
    (OUT / "session.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(lines)} rows, {len(EXCHANGES)} exchanges -> {OUT / 'session.jsonl'}")


if __name__ == "__main__":
    main()
