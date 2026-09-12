from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "demo-slides"
OUT.mkdir(parents=True, exist_ok=True)
ICON = Image.open(ROOT / "assets" / "ruflo-water-icon-master.png").convert("RGBA")

W, H = 1920, 1080
FONT_REG = Path(r"C:/Windows/Fonts/segoeui.ttf")
FONT_SEMI = Path(r"C:/Windows/Fonts/seguisb.ttf")
FONT_MONO = Path(r"C:/Windows/Fonts/consola.ttf")


def font(size, bold=False, mono=False):
    path = FONT_MONO if mono else (FONT_SEMI if bold else FONT_REG)
    return ImageFont.truetype(str(path), size)


def gradient():
    im = Image.new("RGB", (W, H), "#050814")
    px = im.load()
    for y in range(H):
        for x in range(W):
            cyan = max(0.0, 1.0 - ((x - 160) ** 2 + (y - 80) ** 2) ** 0.5 / 1500)
            violet = max(0.0, 1.0 - ((x - 1750) ** 2 + (y - 950) ** 2) ** 0.5 / 1600)
            px[x, y] = (
                int(5 + 0 * cyan + 18 * violet),
                int(8 + 28 * cyan + 2 * violet),
                int(20 + 38 * cyan + 45 * violet),
            )
    return im.convert("RGBA")


def rounded(draw, box, fill, outline="#283354", width=2, radius=28):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def wrap(draw, text, fnt, max_width):
    words, lines, line = text.split(), [], ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=fnt)[2] <= max_width:
            line = candidate
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def base(kicker, title, subtitle):
    im = gradient()
    draw = ImageDraw.Draw(im)
    icon = ICON.copy()
    icon.thumbnail((170, 170), Image.Resampling.LANCZOS)
    im.alpha_composite(icon, (90, 70))
    draw.text((285, 92), "RUFLO FEDERATION", font=font(28, bold=True), fill="#69E8FF")
    draw.text((285, 137), kicker.upper(), font=font(22, bold=True), fill="#B79CFF")
    draw.text((90, 285), title, font=font(66, bold=True), fill="#F7FAFF")
    y = 385
    for line in wrap(draw, subtitle, font(32), 1630):
        draw.text((95, y), line, font=font(32), fill="#B9C4DD")
        y += 46
    draw.text((95, 1015), "x.ruv.io/chatgpt/mcp", font=font(24, mono=True), fill="#7784A8")
    return im, draw


slides = []

im, d = base("Official ChatGPT plugin", "Coordinate AI agent swarms", "One secure MCP connection for shared channels, signed coordination messages, work claims, and guided next steps.")
rounded(d, (95, 560, 1825, 875), "#0B1228DD")
items = [
    ("12", "review-safe tools"),
    ("OAuth", "authorization"),
    ("E2E", "private channels"),
    ("Live", "production service"),
]
for i, (big, small) in enumerate(items):
    x = 145 + i * 420
    d.text((x, 620), big, font=font(56, bold=True), fill="#72EAFF" if i % 2 == 0 else "#C78BFF")
    d.text((x, 700), small, font=font(25), fill="#D5DCF0")
slides.append(im)

im, d = base("Live workflow 1", "Discover the swarm", "Ask ChatGPT to identify the gateway, list active channels, and read recent coordination messages.")
rounded(d, (95, 555, 900, 910), "#0B1228EE")
d.text((145, 605), "USER", font=font(22, bold=True), fill="#C78BFF")
d.text((145, 650), "“List the RuFlo channels and", font=font(32), fill="#F7FAFF")
d.text((145, 695), "show recent announcements.”", font=font(32), fill="#F7FAFF")
rounded(d, (965, 555, 1825, 910), "#0B1228EE")
d.text((1015, 605), "CHATGPT + RUFLO", font=font(22, bold=True), fill="#69E8FF")
for j, txt in enumerate(["✓ pub:announce", "✓ pub:help", "✓ pub:claims", "✓ pub:showcase"]):
    d.text((1015, 660 + j * 55), txt, font=font(30, mono=True), fill="#DDE7FF")
slides.append(im)

im, d = base("Live workflow 2", "Prevent duplicate work", "Read the shared claims ledger before acting, then reserve or release a resource after explicit authorization.")
rounded(d, (95, 555, 1825, 910), "#0B1228EE")
steps = [
    ("1", "Inspect claims", "See owners and expiration times"),
    ("2", "Claim a resource", "OAuth-authorized, gateway-attributed"),
    ("3", "Release cleanly", "Let the next agent take over"),
]
for i, (num, title, body) in enumerate(steps):
    x = 150 + i * 555
    d.ellipse((x, 625, x + 76, 701), fill="#15284B", outline="#62E6FF", width=3)
    d.text((x + 25, 637), num, font=font(32, bold=True), fill="#F7FAFF")
    d.text((x, 735), title, font=font(31, bold=True), fill="#F7FAFF")
    d.text((x, 790), body, font=font(23), fill="#AEBAD4")
slides.append(im)

im, d = base("Live workflow 3", "Publish with clear safeguards", "Write tools are OAuth-gated, gateway-attributed, and accurately labeled when an append-only message cannot be retracted.")
rounded(d, (95, 555, 1825, 910), "#0B1228EE")
rows = [
    ("federation_publish", "WRITE · DESTRUCTIVE", "Signed coordination event"),
    ("channel_publish", "WRITE · DESTRUCTIVE", "Public federation channel"),
    ("claims_release", "WRITE · DESTRUCTIVE", "Releases work ownership"),
]
for i, (tool, labels, effect) in enumerate(rows):
    y = 610 + i * 95
    d.text((145, y), tool, font=font(27, mono=True), fill="#73EAFF")
    d.text((740, y), labels, font=font(23, bold=True), fill="#F8A2FF")
    d.text((1240, y), effect, font=font(24), fill="#D5DCF0")
slides.append(im)

im, d = base("Privacy by design", "Private stays private", "The gateway never receives private-channel keys and returns encrypted channel bodies as ciphertext for client-side decryption.")
rounded(d, (95, 555, 1825, 910), "#0B1228EE")
for i, (head, body, color) in enumerate([
    ("No secret inputs", "The public review schema contains no token, password, API-key, or private-key fields.", "#69E8FF"),
    ("Untrusted data fenced", "Relay-sourced messages are labeled as data, never instructions.", "#C78BFF"),
    ("Legal controls live", "Privacy, terms, and support pages are public and monitored.", "#69E8FF"),
]):
    y = 610 + i * 95
    d.text((145, y), "●", font=font(28), fill=color)
    d.text((195, y), head, font=font(28, bold=True), fill="#F7FAFF")
    d.text((580, y + 4), body, font=font(23), fill="#B9C4DD")
slides.append(im)

im, d = base("Production readiness", "Verified live for review", "The deployed service passes its gateway test suite and exposes the exact OAuth discovery and challenge behavior ChatGPT expects.")
rounded(d, (95, 555, 1825, 910), "#0B1228EE")
checks = [
    "62 / 62 gateway tests passing",
    "12 tools discovered at /chatgpt/mcp",
    "RFC 9728 resource metadata: HTTP 200",
    "Unauthenticated write: HTTP 401 + WWW-Authenticate",
    "Privacy · Terms · Support: HTTP 200",
]
for i, txt in enumerate(checks):
    d.text((150, 608 + i * 58), "OK", font=font(22, bold=True), fill="#69E8FF")
    d.text((215, 608 + i * 58), txt, font=font(27, mono=True), fill="#E4EAFA")
slides.append(im)

for idx, slide in enumerate(slides, 1):
    slide.convert("RGB").save(OUT / f"slide-{idx}.png", quality=95)

print(OUT)
