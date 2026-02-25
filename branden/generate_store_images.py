#!/usr/bin/env python3
"""Generate Chrome Web Store screenshots and promo tiles."""

from PIL import Image, ImageDraw, ImageFont
import os

OUT = "/home/branden/myproject/chrome-extensions-samples/branden/store-assets"
os.makedirs(OUT, exist_ok=True)

# Fonts
FONT_EN = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
FONT_EN_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_KR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_KR_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc"
ICON_PATH = "/home/branden/myproject/chrome-extensions-samples/branden/icons/icon128.png"

# Colors
BG = "#f8fafc"
BLUE = "#2563eb"
DARK_BLUE = "#1e40af"
WHITE = "#ffffff"
DARK = "#1e293b"
GRAY = "#64748b"
LIGHT_GRAY = "#e2e8f0"
GREEN = "#16a34a"
AMBER = "#f59e0b"
PURPLE = "#7c3aed"
RED = "#dc2626"
LIGHT_BLUE_BG = "#eff6ff"
AMBER_BG = "#fffbeb"
AMBER_BORDER = "#fde68a"


def font(path, size):
    return ImageFont.truetype(path, size)


def rounded_rect(draw, xy, radius, fill, outline=None):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline)


def draw_pill(draw, xy, text, bg, fg, fnt):
    x, y = xy
    bbox = fnt.getbbox(text)
    w = bbox[2] - bbox[0] + 16
    h = bbox[3] - bbox[1] + 8
    rounded_rect(draw, (x, y, x + w, y + h), radius=h // 2, fill=bg)
    draw.text((x + 8, y + 3), text, fill=fg, font=fnt)
    return w


def draw_word_row(draw, y, word, korean, level=None, is_open=False, width=380):
    """Draw a word list row."""
    x0 = 0
    row_h = 36

    # Level indicator bar
    if level == "ADV":
        draw.rectangle((x0, y, x0 + 3, y + row_h), fill=AMBER)
    elif level == "INT":
        draw.rectangle((x0, y, x0 + 3, y + row_h), fill=BLUE)

    # Word
    f_word = font(FONT_EN_BOLD, 14)
    draw.text((x0 + 12, y + 10), word, fill=DARK, font=f_word)

    # Badge
    f_badge = font(FONT_EN_BOLD, 9)
    badge_x = x0 + 12 + f_word.getbbox(word)[2] + 8
    if level == "ADV":
        draw_pill(draw, (badge_x, y + 10), "ADV", "#fef3c7", AMBER, f_badge)
    elif level == "INT":
        draw_pill(draw, (badge_x, y + 10), "INT", "#dbeafe", BLUE, f_badge)
    elif level == "TOEFL":
        draw_pill(draw, (badge_x, y + 10), "TOEFL", "#ede9fe", PURPLE, f_badge)

    # Korean
    f_ko = font(FONT_KR, 13)
    ko_w = f_ko.getbbox(korean)[2]
    draw.text((x0 + width - ko_w - 12, y + 10), korean, fill=BLUE, font=f_ko)

    # Separator
    draw.line((x0, y + row_h, x0 + width, y + row_h), fill=LIGHT_GRAY, width=1)
    return row_h


# ============================================================
#  Screenshot 1: Main word list with side panel
# ============================================================
def screenshot1():
    W, H = 1280, 800
    PANEL_W = 400
    PAGE_W = W - PANEL_W   # 880
    CHROME_H = 52

    img = Image.new("RGB", (W, H), "#e8edf3")
    draw = ImageDraw.Draw(img)

    # ── Browser chrome bar ──
    draw.rectangle((0, 0, W, CHROME_H), fill="#dee4ec")
    # Active tab
    rounded_rect(draw, (8, 8, 220, 44), 8, WHITE)
    draw.text((18, 16), "CNN.com - Breaking News", fill=DARK, font=font(FONT_EN, 12))
    # URL bar
    rounded_rect(draw, (240, 12, 780, 40), 14, WHITE)
    draw.text((256, 16), "https://edition.cnn.com/world/live-news/...", fill=GRAY, font=font(FONT_EN, 12))
    # Browser buttons (dots)
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        draw.ellipse((W - 80 + i * 20, 18, W - 68 + i * 20, 30), fill=c)

    # ══════════════════════════════════════════════════════════
    #  LEFT SIDE — Webpage content
    # ══════════════════════════════════════════════════════════
    draw.rectangle((0, CHROME_H, PAGE_W, H), fill="#ffffff")

    # Fake nav bar
    draw.rectangle((0, CHROME_H, PAGE_W, CHROME_H + 40), fill="#cc0000")
    draw.text((24, CHROME_H + 10), "CNN", fill=WHITE, font=font(FONT_EN_BOLD, 18))
    nav_items = ["World", "Politics", "Business", "Health", "Entertainment", "Sports"]
    nx = 100
    for item in nav_items:
        draw.text((nx, CHROME_H + 12), item, fill="#ffcccc", font=font(FONT_EN, 13))
        nx += font(FONT_EN, 13).getbbox(item)[2] + 24

    content_y = CHROME_H + 56

    # Article image placeholder
    img_h = 200
    draw.rectangle((40, content_y, PAGE_W - 40, content_y + img_h), fill="#e2e8f0")
    # Image label
    draw.text((PAGE_W // 2 - 120, content_y + 85), "Global Climate Summit 2026", fill="#94a3b8", font=font(FONT_EN_BOLD, 16))

    content_y += img_h + 20

    # Breadcrumb
    draw.text((40, content_y), "World  >  Climate  >  Summit 2026", fill="#94a3b8", font=font(FONT_EN, 11))
    content_y += 24

    # Article title
    f_title = font(FONT_EN_BOLD, 26)
    draw.text((40, content_y), "Global Climate Summit 2026:", fill=DARK, font=f_title)
    content_y += 34
    draw.text((40, content_y), "Nations Pledge Bold Action on", fill=DARK, font=f_title)
    content_y += 34
    draw.text((40, content_y), "Carbon Emissions", fill=DARK, font=f_title)
    content_y += 48

    # Author & date
    draw.text((40, content_y), "By Sarah Johnson, CNN", fill=GRAY, font=font(FONT_EN_BOLD, 12))
    draw.text((240, content_y), "Updated 10:32 AM EST, Wed February 19, 2026", fill="#94a3b8", font=font(FONT_EN, 11))
    content_y += 28
    draw.line((40, content_y, PAGE_W - 40, content_y), fill=LIGHT_GRAY, width=1)
    content_y += 16

    # Article body
    f_body = font(FONT_EN, 14)
    paragraphs = [
        [
            "World leaders gathered in Geneva on Wednesday to discuss",
            "ambitious new targets for reducing carbon emissions. The",
            "unprecedented summit brought together representatives",
            "from over 190 countries, each presenting their national",
            "strategies for combating climate change.",
        ],
        [
            "The conference, which has been described as a pivotal",
            "moment for international cooperation, aims to establish",
            "binding agreements that would significantly reduce",
            "greenhouse gas emissions by 2035.",
        ],
        [
            "\"This is not just about policy \u2014 it's about the survival",
            "of our planet,\" said the UN Secretary-General in the",
            "opening remarks to thunderous applause.",
        ],
    ]
    for para in paragraphs:
        for line in para:
            draw.text((40, content_y), line, fill="#374151", font=f_body)
            content_y += 21
        content_y += 10

    # ══════════════════════════════════════════════════════════
    #  RIGHT SIDE — Extension side panel
    # ══════════════════════════════════════════════════════════
    panel_x = PAGE_W
    # Panel background
    draw.rectangle((panel_x, CHROME_H, W, H), fill=BG)
    # Left border
    draw.line((panel_x, CHROME_H, panel_x, H), fill="#cbd5e1", width=2)

    px = panel_x + 16
    py = CHROME_H + 12

    # -- Status bar --
    draw.text((px, py), "Translation complete!", fill=GRAY, font=font(FONT_EN, 11))
    f_sm = font(FONT_EN_BOLD, 9)
    rounded_rect(draw, (px + 290, py - 2, px + 336, py + 14), 4, "#fef3c7")
    draw.text((px + 296, py), "CLAUDE", fill="#b45309", font=f_sm)
    draw.text((px + 348, py - 4), "\u2699", fill=GRAY, font=font(FONT_EN, 18))
    py += 26

    # -- Tabs --
    tab_w = 86
    tab_labels = ["All", "Saved 12", "Phrase", "Review"]
    for i, label in enumerate(tab_labels):
        tx = px + i * (tab_w + 4)
        if i == 0:
            rounded_rect(draw, (tx, py, tx + tab_w, py + 26), 6, BLUE)
            draw.text((tx + 10, py + 5), label, fill=WHITE, font=font(FONT_EN_BOLD, 11))
        else:
            rounded_rect(draw, (tx, py, tx + tab_w, py + 26), 6, WHITE, outline=LIGHT_GRAY)
            draw.text((tx + 10, py + 5), label, fill=GRAY, font=font(FONT_EN_BOLD, 11))
    py += 36

    # -- Stats --
    draw.text((px, py), "156/243 translated \u00b7 45 INT \u00b7 28 ADV", fill=GRAY, font=font(FONT_EN, 10))
    py += 20

    # -- Filter bar --
    filters = [("All", "#475569"), ("Basic", GREEN), ("INT", BLUE), ("ADV", AMBER), ("TOEFL", PURPLE)]
    fx = px
    f_fb = font(FONT_EN_BOLD, 10)
    for i, (label, color) in enumerate(filters):
        fw = f_fb.getbbox(label)[2] + 16
        if i == 0:
            rounded_rect(draw, (fx, py, fx + fw, py + 20), 10, color)
            draw.text((fx + 8, py + 3), label, fill=WHITE, font=f_fb)
        else:
            rounded_rect(draw, (fx, py, fx + fw, py + 20), 10, WHITE, outline=LIGHT_GRAY)
            draw.text((fx + 8, py + 3), label, fill=GRAY, font=f_fb)
        fx += fw + 5
    py += 30

    # -- Search bar --
    rounded_rect(draw, (px, py, px + 368, py + 28), 4, WHITE, outline="#ccc")
    draw.text((px + 10, py + 6), "Search words...", fill="#aaa", font=font(FONT_EN, 12))
    py += 38

    # -- Word list (drawn as sub-image to avoid coordinate mess) --
    words = [
        ("ambitious", "\uc57c\uc2ec \ucc2c", "ADV"),
        ("binding", "\uad6c\uc18d\ub825 \uc788\ub294", "INT"),
        ("carbon", "\ud0c4\uc18c", "INT"),
        ("climate", "\uae30\ud6c4", None),
        ("combating", "\ud1b4\uc7c5\ud558\ub294", "ADV"),
        ("conference", "\ud68c\uc758", "INT"),
        ("cooperation", "\ud611\ub825", "TOEFL"),
        ("emissions", "\ubc30\ucd9c", "ADV"),
        ("establish", "\uc124\ub9bd\ud558\ub2e4", "INT"),
        ("gathered", "\ubaa8\uc778", None),
        ("greenhouse", "\uc628\uc2e4", "ADV"),
        ("international", "\uad6d\uc81c\uc801\uc778", None),
        ("nations", "\uad6d\uac00\ub4e4", None),
        ("pivotal", "\uc911\uc694\ud55c", "ADV"),
        ("pledge", "\uc11c\uc57d\ud558\ub2e4", "TOEFL"),
        ("unprecedented", "\uc804\ub840 \uc5c6\ub294", "ADV"),
    ]

    list_h = H - py - 4
    panel_img = Image.new("RGB", (PANEL_W - 20, list_h), BG)
    pd = ImageDraw.Draw(panel_img)
    wy = 0
    for w, ko, level in words:
        if wy + 34 > list_h:
            break
        h = draw_word_row(pd, wy, w, ko, level, width=PANEL_W - 26)
        wy += h
    img.paste(panel_img, (px, py))

    img.save(f"{OUT}/screenshot-1-word-list.png", "PNG")
    print("screenshot-1 done")


# ============================================================
#  Screenshot 2: Word detail expanded (AI analysis)
# ============================================================
def screenshot2():
    img = Image.new("RGB", (1280, 800), BG)
    draw = ImageDraw.Draw(img)

    # Title area
    icon = Image.open(ICON_PATH).resize((64, 64))
    img.paste(icon, (40, 30))
    draw.text((120, 36), "English to Korean Translator", fill=DARK, font=font(FONT_EN_BOLD, 28))
    draw.text((120, 72), "AI-Powered Word Analysis", fill=BLUE, font=font(FONT_EN_BOLD, 16))

    # Central card showing word detail
    card_x, card_y = 80, 120
    card_w, card_h = 1120, 640
    rounded_rect(draw, (card_x, card_y, card_x + card_w, card_y + card_h), 16, WHITE, outline=LIGHT_GRAY)

    cx = card_x + 40
    cy = card_y + 30

    # Word header
    draw.text((cx, cy), "unprecedented", fill=DARK, font=font(FONT_EN_BOLD, 32))
    # Badge
    f_b = font(FONT_EN_BOLD, 12)
    bx = cx + font(FONT_EN_BOLD, 32).getbbox("unprecedented")[2] + 16
    draw_pill(draw, (bx, cy + 8), "ADV", "#fef3c7", AMBER, f_b)
    bx2 = bx + 60
    draw_pill(draw, (bx2, cy + 8), "TOEFL", "#ede9fe", PURPLE, f_b)
    # Korean
    draw.text((cx + card_w - 300, cy + 4), "\uc804\ub840 \uc5c6\ub294", fill=BLUE, font=font(FONT_KR_BOLD, 26))

    cy += 60

    # Context box
    ctx_h = 110
    rounded_rect(draw, (cx, cy, cx + card_w - 80, cy + ctx_h), 8, AMBER_BG, outline=AMBER_BORDER)
    draw.text((cx + 14, cy + 10), "\ubb38\ub9e5 \uc18d \uc758\ubbf8", fill="#b45309", font=font(FONT_KR_BOLD, 11))
    draw.text((cx + 14, cy + 30), '"The unprecedented summit brought together representatives from over 190 countries"',
              fill="#78716c", font=font(FONT_EN, 13))
    draw.text((cx + 14, cy + 54), "\uc804\ub840 \uc5c6\ub294 \uc815\uc0c1 \ud68c\ub2f4\uc774 190\uac1c\uad6d \uc774\uc0c1\uc758 \ub300\ud45c\ub4e4\uc744 \ud55c\uc790\ub9ac\uc5d0 \ubaa8\uc558\ub2e4",
              fill="#d97706", font=font(FONT_KR_BOLD, 14))
    draw.text((cx + 14, cy + 78), "\uc774\uc804\uc5d0 \uc5c6\uc5c8\ub358 \uaddc\ubaa8\uc640 \uc911\uc694\uc131\uc744 \uac15\uc870\ud558\ub294 \ud45c\ud604\uc73c\ub85c, \uc5ed\uc0ac\uc801\uc73c\ub85c \uc720\ub840\uac00 \uc5c6\ub294 \uc0ac\uac74\uc784\uc744 \ub098\ud0c0\ub0c4",
              fill="#92400e", font=font(FONT_KR, 11))
    cy += ctx_h + 16

    # Two-column layout
    col1_x = cx
    col2_x = cx + (card_w - 80) // 2 + 20

    # Left column - Definitions
    draw.text((col1_x, cy), "\uc0ac\uc804 \uc815\uc758", fill=GRAY, font=font(FONT_KR_BOLD, 11))
    cy_l = cy + 22
    defs = [
        ("\ud615\uc6a9\uc0ac", "\uc804\ub840 \uc5c6\ub294, \uc804\ub300\ubbf8\ubb38\uc758", "an unprecedented achievement"),
        ("\ud615\uc6a9\uc0ac", "\uc720\ub840\uac00 \uc5c6\ub294, \ube44\ud560 \ub370 \uc5c6\ub294", "unprecedented growth in sales"),
    ]
    for pos, meaning, ex in defs:
        # POS pill
        rounded_rect(draw, (col1_x, cy_l, col1_x + 50, cy_l + 18), 3, "#6366f1")
        draw.text((col1_x + 6, cy_l + 2), pos, fill=WHITE, font=font(FONT_KR, 10))
        draw.line((col1_x - 4, cy_l, col1_x - 4, cy_l + 50), fill="#6366f1", width=2)
        draw.text((col1_x + 56, cy_l), meaning, fill=DARK, font=font(FONT_KR_BOLD, 13))
        draw.text((col1_x + 8, cy_l + 22), ex, fill=GRAY, font=font(FONT_EN, 11))
        cy_l += 50

    # Grammar
    draw.text((col1_x, cy_l + 8), "GRAMMAR", fill=GRAY, font=font(FONT_EN_BOLD, 11))
    draw.text((col1_x, cy_l + 26), "un- (\ubd80\uc815) + precedent (\uc804\ub840) + -ed", fill="#475569", font=font(FONT_KR, 12))
    draw.text((col1_x, cy_l + 44), "\ubcf4\ud1b5 \uba85\uc0ac \uc55e\uc5d0\uc11c \uc218\uc2dd\uc5b4\ub85c \uc0ac\uc6a9", fill="#475569", font=font(FONT_KR, 12))

    # Right column - Idioms, Examples, Synonyms
    cy_r = cy + 22
    draw.text((col2_x, cy - 0), "IDIOMS", fill=GRAY, font=font(FONT_EN_BOLD, 11))
    idioms = [
        ("set an unprecedented record", "\uc804\ub840 \uc5c6\ub294 \uae30\ub85d\uc744 \uc138\uc6b0\ub2e4"),
        ("unprecedented in history", "\uc5ed\uc0ac\uc801\uc73c\ub85c \uc720\ub840\uac00 \uc5c6\ub294"),
    ]
    for expr, meaning in idioms:
        draw.line((col2_x - 4, cy_r, col2_x - 4, cy_r + 36), fill="#a78bfa", width=2)
        draw.text((col2_x, cy_r), expr, fill="#5b21b6", font=font(FONT_EN_BOLD, 12))
        draw.text((col2_x, cy_r + 18), meaning, fill="#475569", font=font(FONT_KR, 11))
        cy_r += 42

    draw.text((col2_x, cy_r + 4), "EXAMPLES", fill=GRAY, font=font(FONT_EN_BOLD, 11))
    cy_r += 22
    examples = [
        ("The company reported unprecedented profits.", "\ud68c\uc0ac\ub294 \uc804\ub840 \uc5c6\ub294 \uc218\uc775\uc744 \ubcf4\uace0\ud588\ub2e4."),
        ("We face unprecedented challenges.", "\uc6b0\ub9ac\ub294 \uc804\ub840 \uc5c6\ub294 \ub3c4\uc804\uc5d0 \uc9c1\uba74\ud574 \uc788\ub2e4."),
    ]
    for en, ko in examples:
        draw.line((col2_x - 4, cy_r, col2_x - 4, cy_r + 36), fill=LIGHT_GRAY, width=2)
        draw.text((col2_x, cy_r), en, fill=DARK, font=font(FONT_EN, 12))
        draw.text((col2_x, cy_r + 18), ko, fill=BLUE, font=font(FONT_KR, 11))
        cy_r += 42

    # Synonyms / Antonyms at bottom
    bot_y = cy_l + 80
    draw.text((col1_x, bot_y), "\ub3d9\uc758\uc5b4", fill=GRAY, font=font(FONT_KR_BOLD, 11))
    draw.text((col1_x + 46, bot_y), "unparalleled, unheard-of, extraordinary", fill=GREEN, font=font(FONT_EN, 12))
    draw.text((col1_x, bot_y + 22), "\ubc18\uc758\uc5b4", fill=GRAY, font=font(FONT_KR_BOLD, 11))
    draw.text((col1_x + 46, bot_y + 22), "common, typical", fill=RED, font=font(FONT_EN, 12))

    img.save(f"{OUT}/screenshot-2-word-detail.png", "PNG")
    print("screenshot-2 done")


# ============================================================
#  Screenshot 3: Phrase mode
# ============================================================
def screenshot3():
    img = Image.new("RGB", (1280, 800), BG)
    draw = ImageDraw.Draw(img)

    icon = Image.open(ICON_PATH).resize((48, 48))
    img.paste(icon, (40, 24))
    draw.text((100, 28), "Phrase Mode", fill=DARK, font=font(FONT_EN_BOLD, 28))
    draw.text((100, 60), "Don't understand a phrase? Ask AI to explain it in context.", fill=GRAY, font=font(FONT_EN, 15))

    # Phrase input mockup
    iy = 110
    rounded_rect(draw, (80, iy, 1000, iy + 44), 8, WHITE, outline="#ccc")
    draw.text((96, iy + 12), "carry out", fill=DARK, font=font(FONT_EN, 16))
    rounded_rect(draw, (1020, iy, 1120, iy + 44), 8, BLUE)
    draw.text((1038, iy + 12), "Ask AI", fill=WHITE, font=font(FONT_EN_BOLD, 14))

    # Phrase result card
    cy = iy + 70
    card_w = 1120
    rounded_rect(draw, (80, cy, 80 + card_w, cy + 600), 12, WHITE, outline=LIGHT_GRAY)
    cx = 120

    draw.text((cx, cy + 20), '"carry out"', fill=DARK, font=font(FONT_EN_BOLD, 24))
    draw.text((cx, cy + 56), "\uc218\ud589\ud558\ub2e4, \uc2e4\ud589\ud558\ub2e4", fill=BLUE, font=font(FONT_KR_BOLD, 20))

    cy2 = cy + 96
    sections = [
        ("\ud45c\ud604 \uc758\ubbf8", "\uc5b4\ub5a4 \uacc4\ud68d, \uc784\ubb34, \uc9c0\uc2dc \ub4f1\uc744 \uc2e4\uc81c\ub85c \uc2e4\ud589\ud558\ub2e4\ub294 \ub73b\uc785\ub2c8\ub2e4.\n'carry'\ub294 '\ub098\ub974\ub2e4', 'out'\uc740 '\ub05d\uae4c\uc9c0'\ub77c\ub294 \uc758\ubbf8\ub85c,\n\ud569\uccd0\uc11c '\ub05d\uae4c\uc9c0 \ud574\ub0b4\ub2e4'\ub77c\ub294 \ub9ac\uc774 \ub429\ub2c8\ub2e4.", False),
        ("\ub2e8\uc5b4\ubcc4 \ubd84\uc11d", "carry = \ub098\ub974\ub2e4, \uc6b4\ubc18\ud558\ub2e4 / out = \ubc16\uc73c\ub85c, \ub05d\uae4c\uc9c0\n\uac01\uac01\uc758 \ub2e8\uc5b4\ub294 \ub2e8\uc21c\ud558\uc9c0\ub9cc, \ud569\uccd0\uc9c0\uba74 '\uc2e4\ud589\ud558\ub2e4'\ub77c\ub294\n\uc0c8\ub85c\uc6b4 \uc758\ubbf8\uac00 \ub429\ub2c8\ub2e4 (phrasal verb).", False),
        ("\uc774 \uae00\uc5d0\uc11c\uc758 \uc758\ubbf8", "\uae30\uc0ac\uc5d0\uc11c \uac01 \uad6d\uac00\uac00 \ud0c4\uc18c \ubc30\ucd9c \uac10\ucd95 \uacc4\ud68d\uc744 '\uc2e4\ud589\ud558\ub2e4'\ub77c\ub294\n\uc758\ubbf8\ub85c \uc0ac\uc6a9\ub418\uc5c8\uc2b5\ub2c8\ub2e4.", True),
    ]

    for label, text, is_context in sections:
        if is_context:
            box_h = 70
            rounded_rect(draw, (cx, cy2, cx + card_w - 80, cy2 + box_h), 8, AMBER_BG, outline=AMBER_BORDER)
            draw.text((cx + 12, cy2 + 8), label, fill="#b45309", font=font(FONT_KR_BOLD, 11))
            for i, line in enumerate(text.split("\n")):
                draw.text((cx + 12, cy2 + 26 + i * 18), line, fill="#92400e", font=font(FONT_KR, 12))
            cy2 += box_h + 16
        else:
            draw.text((cx, cy2), label, fill=GRAY, font=font(FONT_KR_BOLD, 11))
            cy2 += 18
            for line in text.split("\n"):
                draw.text((cx, cy2), line, fill="#475569", font=font(FONT_KR, 13))
                cy2 += 20
            cy2 += 14

    # Examples
    draw.text((cx, cy2), "EXAMPLES", fill=GRAY, font=font(FONT_EN_BOLD, 11))
    cy2 += 20
    exs = [
        ("The team carried out the experiment successfully.", "\ud300\uc740 \uc2e4\ud5d8\uc744 \uc131\uacf5\uc801\uc73c\ub85c \uc218\ud589\ud588\ub2e4."),
        ("Please carry out the instructions carefully.", "\uc9c0\uc2dc\uc0ac\ud56d\uc744 \uc8fc\uc758 \uae4a\uac8c \uc2e4\ud589\ud574 \uc8fc\uc138\uc694."),
    ]
    for en, ko in exs:
        draw.line((cx - 4, cy2, cx - 4, cy2 + 36), fill=LIGHT_GRAY, width=2)
        draw.text((cx, cy2), en, fill=DARK, font=font(FONT_EN, 13))
        draw.text((cx, cy2 + 20), ko, fill=BLUE, font=font(FONT_KR, 12))
        cy2 += 44

    # Similar
    draw.text((cx, cy2 + 4), "\ube44\uc2b7\ud55c \ud45c\ud604", fill=GRAY, font=font(FONT_KR_BOLD, 11))
    draw.text((cx + 80, cy2 + 4), "execute  \u00b7  perform  \u00b7  conduct  \u00b7  implement", fill=GREEN, font=font(FONT_EN, 13))

    img.save(f"{OUT}/screenshot-3-phrase-mode.png", "PNG")
    print("screenshot-3 done")


# ============================================================
#  Screenshot 4: Review / Flashcard mode
# ============================================================
def screenshot4():
    img = Image.new("RGB", (1280, 800), "#f0f4ff")
    draw = ImageDraw.Draw(img)

    icon = Image.open(ICON_PATH).resize((48, 48))
    img.paste(icon, (40, 24))
    draw.text((100, 28), "Review Mode", fill=DARK, font=font(FONT_EN_BOLD, 28))
    draw.text((100, 60), "Flashcard-style review for your saved words", fill=GRAY, font=font(FONT_EN, 15))

    # Card
    card_x, card_y = 240, 120
    card_w, card_h = 800, 580
    # Shadow
    rounded_rect(draw, (card_x + 4, card_y + 4, card_x + card_w + 4, card_y + card_h + 4), 16, "#d4d9e3")
    rounded_rect(draw, (card_x, card_y, card_x + card_w, card_y + card_h), 16, WHITE)

    cx = card_x + card_w // 2

    # Progress
    draw.text((cx - 20, card_y + 24), "5 / 12", fill=GRAY, font=font(FONT_EN, 13))

    # Big word
    word = "unprecedented"
    f_big = font(FONT_EN_BOLD, 42)
    ww = f_big.getbbox(word)[2]
    draw.text((cx - ww // 2, card_y + 60), word, fill=DARK, font=f_big)

    # Answer area (revealed)
    ans_y = card_y + 140
    rounded_rect(draw, (card_x + 40, ans_y, card_x + card_w - 40, ans_y + 340), 12, "#f0f4ff")

    # Korean
    ko_text = "\uc804\ub840 \uc5c6\ub294"
    f_ko_big = font(FONT_KR_BOLD, 30)
    kw = f_ko_big.getbbox(ko_text)[2]
    draw.text((cx - kw // 2, ans_y + 16), ko_text, fill=BLUE, font=f_ko_big)

    # Detail inside answer
    dy = ans_y + 64
    dx = card_x + 72

    # Context
    rounded_rect(draw, (dx - 8, dy, card_x + card_w - 72, dy + 60), 6, AMBER_BG, outline=AMBER_BORDER)
    draw.text((dx, dy + 6), "\ubb38\ub9e5:", fill="#b45309", font=font(FONT_KR_BOLD, 12))
    draw.text((dx + 44, dy + 6), '"The unprecedented summit brought together..."', fill="#78716c", font=font(FONT_EN, 12))
    draw.text((dx, dy + 30), "\uc804\ub840 \uc5c6\ub294 \uc815\uc0c1 \ud68c\ub2f4\uc774 \ub300\ud45c\ub4e4\uc744 \ud55c\uc790\ub9ac\uc5d0 \ubaa8\uc558\ub2e4", fill="#d97706", font=font(FONT_KR_BOLD, 12))
    dy += 72

    draw.text((dx, dy), "\uc0ac\uc804 \uc815\uc758:", fill=DARK, font=font(FONT_KR_BOLD, 12))
    dy += 22
    draw.line((dx - 4, dy, dx - 4, dy + 18), fill="#6366f1", width=2)
    draw.text((dx, dy), "\ud615\uc6a9\uc0ac  \uc804\ub840 \uc5c6\ub294, \uc804\ub300\ubbf8\ubb38\uc758", fill=DARK, font=font(FONT_KR, 13))
    dy += 26
    draw.line((dx - 4, dy, dx - 4, dy + 18), fill="#6366f1", width=2)
    draw.text((dx, dy), "\ud615\uc6a9\uc0ac  \uc720\ub840\uac00 \uc5c6\ub294, \ube44\ud560 \ub370 \uc5c6\ub294", fill=DARK, font=font(FONT_KR, 13))
    dy += 30

    draw.text((dx, dy), "Grammar:", fill=DARK, font=font(FONT_EN_BOLD, 12))
    draw.text((dx + 80, dy), "un- (\ubd80\uc815) + precedent (\uc804\ub840) + -ed", fill="#475569", font=font(FONT_KR, 12))
    dy += 24

    draw.text((dx, dy), "Examples:", fill=DARK, font=font(FONT_EN_BOLD, 12))
    dy += 20
    draw.text((dx + 8, dy), "The company reported unprecedented profits.", fill=DARK, font=font(FONT_EN, 12))
    draw.text((dx + 8, dy + 18), "\ud68c\uc0ac\ub294 \uc804\ub840 \uc5c6\ub294 \uc218\uc775\uc744 \ubcf4\uace0\ud588\ub2e4.", fill=BLUE, font=font(FONT_KR, 11))
    dy += 42

    draw.text((dx, dy), "\ub3d9\uc758\uc5b4:", fill=DARK, font=font(FONT_KR_BOLD, 12))
    draw.text((dx + 56, dy), "unparalleled, unheard-of, extraordinary", fill=GREEN, font=font(FONT_EN, 12))

    # Buttons
    btn_y = card_y + card_h - 60
    rounded_rect(draw, (cx - 60, btn_y, cx + 60, btn_y + 40), 8, GREEN)
    draw.text((cx - 22, btn_y + 10), "Next", fill=WHITE, font=font(FONT_EN_BOLD, 15))

    img.save(f"{OUT}/screenshot-4-review-mode.png", "PNG")
    print("screenshot-4 done")


# ============================================================
#  Screenshot 5: Settings / Options page
# ============================================================
def screenshot5():
    img = Image.new("RGB", (1280, 800), "#fafafa")
    draw = ImageDraw.Draw(img)

    # Center card
    card_x, card_y = 380, 60
    card_w, card_h = 520, 680
    rounded_rect(draw, (card_x - 2, card_y - 2, card_x + card_w + 2, card_y + card_h + 2), 12, LIGHT_GRAY)
    rounded_rect(draw, (card_x, card_y, card_x + card_w, card_y + card_h), 12, WHITE)

    cx = card_x + 40
    cy = card_y + 36

    draw.text((cx, cy), "Settings", fill=DARK, font=font(FONT_EN_BOLD, 24))
    cy += 50

    # AI Provider section
    draw.text((cx, cy), "AI Provider", fill=DARK, font=font(FONT_EN_BOLD, 16))
    cy += 8
    draw.line((cx, cy + 18, cx + card_w - 80, cy + 18), fill=LIGHT_GRAY, width=1)
    cy += 28
    draw.text((cx, cy), "Choose which AI to use for word details (grammar, idioms, examples).", fill=GRAY, font=font(FONT_EN, 12))
    draw.text((cx, cy + 16), "Basic translations always use Google Translate.", fill=GRAY, font=font(FONT_EN, 12))
    cy += 44

    # Provider toggle buttons
    btn_w = (card_w - 88) // 2
    # Claude (selected)
    rounded_rect(draw, (cx, cy, cx + btn_w, cy + 44), 8, LIGHT_BLUE_BG, outline=BLUE)
    draw.text((cx + btn_w // 2 - 24, cy + 12), "Claude", fill=BLUE, font=font(FONT_EN_BOLD, 15))
    # Gemini
    rounded_rect(draw, (cx + btn_w + 8, cy, cx + btn_w * 2 + 8, cy + 44), 8, WHITE, outline=LIGHT_GRAY)
    draw.text((cx + btn_w + 8 + btn_w // 2 - 26, cy + 12), "Gemini", fill=GRAY, font=font(FONT_EN_BOLD, 15))
    cy += 64

    # Claude section
    draw.text((cx, cy), "Claude", fill=DARK, font=font(FONT_EN_BOLD, 16))
    cy += 8
    draw.line((cx, cy + 18, cx + card_w - 80, cy + 18), fill=LIGHT_GRAY, width=1)
    cy += 30

    draw.text((cx, cy), "API Key", fill="#555", font=font(FONT_EN_BOLD, 12))
    cy += 20
    input_w = card_w - 80
    rounded_rect(draw, (cx, cy, cx + input_w, cy + 36), 4, WHITE, outline="#ccc")
    draw.text((cx + 10, cy + 9), "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", fill=DARK, font=font(FONT_EN, 14))
    cy += 52

    draw.text((cx, cy), "Model", fill="#555", font=font(FONT_EN_BOLD, 12))
    cy += 20
    rounded_rect(draw, (cx, cy, cx + input_w, cy + 36), 4, WHITE, outline="#ccc")
    draw.text((cx + 10, cy + 9), "Haiku 4.5 (Fast)", fill=DARK, font=font(FONT_EN, 13))
    # Dropdown arrow
    draw.text((cx + input_w - 24, cy + 8), "\u25bc", fill=GRAY, font=font(FONT_EN, 12))
    cy += 56

    # Info box
    rounded_rect(draw, (cx, cy, cx + input_w, cy + 70), 8, "#f0fdf4", outline="#bbf7d0")
    draw.text((cx + 14, cy + 10), "Your API key stays in your browser.", fill=GREEN, font=font(FONT_EN_BOLD, 13))
    draw.text((cx + 14, cy + 30), "It is never sent to any third-party server.", fill="#166534", font=font(FONT_EN, 12))
    draw.text((cx + 14, cy + 48), "Get a key free at console.anthropic.com", fill="#166534", font=font(FONT_EN, 12))
    cy += 88

    # Save button
    rounded_rect(draw, (cx, cy, cx + 100, cy + 38), 4, BLUE)
    draw.text((cx + 28, cy + 9), "Save", fill=WHITE, font=font(FONT_EN_BOLD, 14))
    draw.text((cx + 120, cy + 12), "Saved! Using Claude (haiku) for word details.", fill=GREEN, font=font(FONT_EN, 12))

    # Side labels
    draw.text((40, 200), "Bring Your Own Key", fill=BLUE, font=font(FONT_EN_BOLD, 22))
    draw.text((40, 234), "No built-in API keys.\nUsers provide their own\nClaude or Gemini key.\n\nYour key, your control.", fill=GRAY, font=font(FONT_EN, 14))

    draw.text((40, 420), "Choose Your AI", fill=BLUE, font=font(FONT_EN_BOLD, 22))
    draw.text((40, 454), "Claude (Anthropic)\nor Gemini (Google)\n\nPick the model that\nfits your needs.", fill=GRAY, font=font(FONT_EN, 14))

    img.save(f"{OUT}/screenshot-5-settings.png", "PNG")
    print("screenshot-5 done")


# ============================================================
#  Small Promo Tile (440x280)
# ============================================================
def promo_small():
    img = Image.new("RGB", (440, 280), BLUE)
    draw = ImageDraw.Draw(img)

    # Subtle gradient effect via layered rectangles
    for i in range(280):
        r = int(37 + (30 * i / 280))
        g = int(99 + (30 * i / 280))
        b = int(235 - (20 * i / 280))
        draw.line((0, i, 440, i), fill=(r, g, b))

    icon = Image.open(ICON_PATH).resize((56, 56))
    img.paste(icon, (30, 30))

    draw.text((30, 100), "English to Korean", fill=WHITE, font=font(FONT_EN_BOLD, 26))
    draw.text((30, 134), "Translator", fill=WHITE, font=font(FONT_EN_BOLD, 26))

    draw.text((30, 180), "AI-powered vocabulary learning", fill="#bfdbfe", font=font(FONT_EN, 14))
    draw.text((30, 200), "from any webpage", fill="#bfdbfe", font=font(FONT_EN, 14))

    # Feature pills at bottom
    py = 236
    px = 30
    f_pill = font(FONT_EN_BOLD, 10)
    pills = ["TOEFL", "Claude", "Gemini", "Flashcards"]
    for label in pills:
        pw = f_pill.getbbox(label)[2] + 14
        rounded_rect(draw, (px, py, px + pw, py + 22), 11, "#4b7fe8")
        draw.text((px + 7, py + 4), label, fill=WHITE, font=f_pill)
        px += pw + 6

    img.save(f"{OUT}/promo-small-440x280.png", "PNG")
    print("promo-small done")


# ============================================================
#  Marquee Promo Tile (1400x560)
# ============================================================
def promo_marquee():
    img = Image.new("RGB", (1400, 560), BLUE)
    draw = ImageDraw.Draw(img)

    # Gradient background
    for i in range(560):
        r = int(30 + (35 * i / 560))
        g = int(64 + (50 * i / 560))
        b = int(175 + (40 * i / 560))
        draw.line((0, i, 1400, i), fill=(r, g, b))

    # Left side - text
    icon = Image.open(ICON_PATH).resize((80, 80))
    img.paste(icon, (80, 60))

    draw.text((80, 160), "English to Korean", fill=WHITE, font=font(FONT_EN_BOLD, 48))
    draw.text((80, 220), "Translator", fill=WHITE, font=font(FONT_EN_BOLD, 48))

    draw.text((80, 300), "AI-powered vocabulary learning from any webpage", fill="#bfdbfe", font=font(FONT_EN, 20))

    # Feature list
    features = [
        "Auto word extraction & translation",
        "AI analysis: grammar, idioms, examples",
        "TOEFL vocabulary classification",
        "Phrase explanation in context",
        "Flashcard review system",
    ]
    fy = 350
    for feat in features:
        draw.text((96, fy), "\u2713", fill="#86efac", font=font(FONT_EN_BOLD, 16))
        draw.text((120, fy), feat, fill="#e0f2fe", font=font(FONT_EN, 16))
        fy += 28

    # Right side - mockup card
    card_x, card_y = 820, 40
    card_w, card_h = 500, 480
    # Shadow
    rounded_rect(draw, (card_x + 6, card_y + 6, card_x + card_w + 6, card_y + card_h + 6), 16, "#1a3a6e")
    rounded_rect(draw, (card_x, card_y, card_x + card_w, card_y + card_h), 16, WHITE)

    mx = card_x + 24
    my = card_y + 20

    # Mini word list
    draw.text((mx, my), "Translation complete!", fill=GRAY, font=font(FONT_EN, 10))
    f_badge_sm = font(FONT_EN_BOLD, 8)
    rounded_rect(draw, (mx + 380, my, mx + 416, my + 14), 3, "#fef3c7")
    draw.text((mx + 385, my + 1), "CLAUDE", fill="#b45309", font=f_badge_sm)
    my += 24

    # Tabs
    tab_labels = ["All", "Saved", "Phrase", "Review"]
    tx = mx
    for i, t in enumerate(tab_labels):
        tw = 105
        if i == 0:
            rounded_rect(draw, (tx, my, tx + tw, my + 24), 5, BLUE)
            draw.text((tx + 10, my + 5), t, fill=WHITE, font=font(FONT_EN_BOLD, 10))
        else:
            rounded_rect(draw, (tx, my, tx + tw, my + 24), 5, "#f8fafc", outline=LIGHT_GRAY)
            draw.text((tx + 10, my + 5), t, fill=GRAY, font=font(FONT_EN_BOLD, 10))
        tx += tw + 4
    my += 36

    # Mini word rows
    mini_words = [
        ("ambitious", "\uc57c\uc2ec \ucc2c", "ADV"),
        ("binding", "\uad6c\uc18d\ub825 \uc788\ub294", "INT"),
        ("carbon", "\ud0c4\uc18c", None),
        ("climate", "\uae30\ud6c4", None),
        ("combating", "\ud1b5\uc7c5\ud558\ub294", "ADV"),
        ("cooperation", "\ud611\ub825", None),
        ("emissions", "\ubc30\ucd9c", "ADV"),
        ("establish", "\uc124\ub9bd\ud558\ub2e4", "INT"),
        ("gathered", "\ubaa8\uc778", None),
        ("greenhouse", "\uc628\uc2e4", "ADV"),
        ("pivotal", "\uc911\uc694\ud55c", "ADV"),
        ("pledge", "\uc11c\uc57d\ud558\ub2e4", None),
        ("unprecedented", "\uc804\ub840 \uc5c6\ub294", "ADV"),
    ]
    f_mw = font(FONT_EN_BOLD, 12)
    f_mk = font(FONT_KR, 11)
    f_mb = font(FONT_EN_BOLD, 8)
    for w, ko, level in mini_words:
        if my > card_y + card_h - 20:
            break
        if level == "ADV":
            draw.rectangle((mx, my, mx + 3, my + 28), fill=AMBER)
        elif level == "INT":
            draw.rectangle((mx, my, mx + 3, my + 28), fill=BLUE)
        draw.text((mx + 10, my + 6), w, fill=DARK, font=f_mw)
        if level:
            bx = mx + 10 + f_mw.getbbox(w)[2] + 6
            bg = "#fef3c7" if level == "ADV" else "#dbeafe"
            clr = AMBER if level == "ADV" else BLUE
            bw = f_mb.getbbox(level)[2] + 10
            rounded_rect(draw, (bx, my + 8, bx + bw, my + 20), 6, bg)
            draw.text((bx + 5, my + 8), level, fill=clr, font=f_mb)
        kw = f_mk.getbbox(ko)[2]
        draw.text((mx + 440 - kw, my + 6), ko, fill=BLUE, font=f_mk)
        draw.line((mx, my + 28, mx + 452, my + 28), fill=LIGHT_GRAY, width=1)
        my += 29

    img.save(f"{OUT}/promo-marquee-1400x560.png", "PNG")
    print("promo-marquee done")


if __name__ == "__main__":
    screenshot1()
    screenshot2()
    screenshot3()
    screenshot4()
    screenshot5()
    promo_small()
    promo_marquee()
    print(f"\nAll images saved to {OUT}/")
