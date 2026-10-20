#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MoneyForUp — генератор премиальных обложек кейсов (960x540, JPEG q~88).

Рисует процедурную «фотографию» тёмного премиального стиля: глубокий чёрный/
графитовый фон, акцентное свечение, световые лучи, зерно, виньетка и
3D-подобные геометрические силуэты продуктов. Эмодзи не используются.

Единственный источник правды — словарь CASES (id -> палитра + мотив).
Мотив выбирает функцию сцены из SCENES, поэтому все 20 обложек
перегенерируются одной командой:

    python tools/generate-case-covers.py
    python tools/generate-case-covers.py --only case_500 omega_core
    python tools/generate-case-covers.py --out-root C:\\tmp\\covers
    python tools/generate-case-covers.py --no-public

Файлы пишутся в assets/cases/<id>.jpg и public/assets/cases/<id>.jpg.
Шрифт — Segoe UI Bold (кириллица), fallback Arial Bold. Рендер идёт в
двойном разрешении (SS=2) и уменьшается LANCZOS для чистого антиалиасинга.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------------------
# Геометрия кадра
# ---------------------------------------------------------------------------
W, H = 960, 540
SS = 2                      # суперсэмплинг
CW, CH = W * SS, H * SS
JPEG_QUALITY = 88
MAX_BYTES = 400 * 1024

WHITE = np.array([1.0, 1.0, 1.0], np.float32)
BLACK = np.array([0.0, 0.0, 0.0], np.float32)

FONT_FILES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
]

FONT_CACHE: dict[int, ImageFont.FreeTypeFont] = {}


def font(size_px: int) -> ImageFont.FreeTypeFont:
    """Bold-шрифт с кириллицей; размер в пикселях уже с учётом SS."""
    size_px = int(round(size_px))
    if size_px in FONT_CACHE:
        return FONT_CACHE[size_px]
    for path in FONT_FILES:
        if os.path.isfile(path):
            try:
                face = ImageFont.truetype(path, size_px)
                FONT_CACHE[size_px] = face
                return face
            except OSError:
                continue
    raise RuntimeError(
        "Не найден жирный шрифт с кириллицей: "
        r"C:\Windows\Fonts\segoeuib.ttf или arialbd.ttf"
    )


def hx(value: str) -> np.ndarray:
    """'#aabbcc' -> np.float32[3] в 0..1."""
    value = value.lstrip("#")
    return np.array([int(value[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


def mix(a, b, t: float) -> np.ndarray:
    a = np.asarray(a, np.float32)
    b = np.asarray(b, np.float32)
    return a * (1.0 - t) + b * t


def clip01(v):
    return np.clip(v, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Примитивы путей (координаты в «дизайнерских» пикселях 960x540)
# ---------------------------------------------------------------------------
def rr_points(cx, cy, w, h, r, angle_deg=0.0, seg=6):
    """Точки скруглённого прямоугольника (центр cx,cy), можно повернуть."""
    hw, hh = w / 2.0, h / 2.0
    r = max(0.0, min(r, hw, hh))
    pts = []

    def arc(ccx, ccy, a0, a1):
        for i in range(seg + 1):
            a = math.radians(a0 + (a1 - a0) * i / seg)
            pts.append((ccx + r * math.cos(a), ccy + r * math.sin(a)))

    # верхняя кромка
    pts.append((-(hw - r), -hh))
    pts.append((hw - r, -hh))
    arc(hw - r, -(hh - r), -90.0, 0.0)
    pts.append((hw, hh - r))
    arc(hw - r, hh - r, 0.0, 90.0)
    pts.append((-(hw - r), hh))
    arc(-(hw - r), hh - r, 90.0, 180.0)
    pts.append((-hw, -(hh - r)))
    arc(-(hw - r), -(hh - r), 180.0, 270.0)

    if angle_deg:
        a = math.radians(angle_deg)
        ca, sa = math.cos(a), math.sin(a)
        rotated = [(px * ca - py * sa, px * sa + py * ca) for px, py in pts]
    else:
        rotated = pts
    return [(cx + px, cy + py) for px, py in rotated]


def bez(p0, p1, p2, p3, n=72):
    """Кубическая кривая Безье -> список точек."""
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
    p0 = np.asarray(p0, np.float32)
    p1 = np.asarray(p1, np.float32)
    p2 = np.asarray(p2, np.float32)
    p3 = np.asarray(p3, np.float32)
    pts = ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3
    return [(float(x), float(y)) for x, y in pts]


def arc_points(cx, cy, rx, ry, a0, a1, n=64):
    out = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        out.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    return out


# ---------------------------------------------------------------------------
# Канва: float32 RGB, все маски в разрешении CW x CH
# ---------------------------------------------------------------------------
class Canvas:
    def __init__(self, seed: int = 0):
        self.a = np.zeros((CH, CW, 3), np.float32)
        self.rng = np.random.default_rng(seed)
        self._draw_probe = ImageDraw.Draw(Image.new("L", (4, 4)))

    # ---------------- маски ----------------
    def _new(self):
        return Image.new("L", (CW, CH), 0)

    @staticmethod
    def _to_np(im):
        return np.asarray(im, np.float32) / 255.0

    def m_poly(self, pts):
        im = self._new()
        ImageDraw.Draw(im).polygon([(p[0] * SS, p[1] * SS) for p in pts], fill=255)
        return self._to_np(im)

    def m_rrect(self, cx, cy, w, h, r, angle_deg=0.0):
        return self.m_poly(rr_points(cx, cy, w, h, r, angle_deg))

    def m_ellipse(self, cx, cy, rx, ry, angle_deg=0.0):
        rx = max(0.2, rx)
        ry = max(0.2, ry)
        if not angle_deg:
            im = self._new()
            ImageDraw.Draw(im).ellipse(
                [((cx - rx) * SS, (cy - ry) * SS), ((cx + rx) * SS, (cy + ry) * SS)],
                fill=255,
            )
            return self._to_np(im)
        pts = []
        for i in range(72):
            a = 2 * math.pi * i / 72
            pts.append((rx * math.cos(a), ry * math.sin(a)))
        a = math.radians(angle_deg)
        ca, sa = math.cos(a), math.sin(a)
        pts = [(cx + px * ca - py * sa, cy + px * sa + py * ca) for px, py in pts]
        return self.m_poly(pts)

    def m_ring(self, cx, cy, rx, ry, thick, angle_deg=0.0):
        outer = self.m_ellipse(cx, cy, rx, ry, angle_deg)
        inner = self.m_ellipse(cx, cy, max(0.1, rx - thick), max(0.1, ry - thick), angle_deg)
        return np.clip(outer - inner, 0.0, 1.0)

    def m_rect(self, x0, y0, x1, y1):
        im = self._new()
        ImageDraw.Draw(im).rectangle(
            [(x0 * SS, y0 * SS), (x1 * SS, y1 * SS)], fill=255
        )
        return self._to_np(im)

    def m_line(self, pts, width, caps=False):
        im = self._new()
        d = ImageDraw.Draw(im)
        d.line([(p[0] * SS, p[1] * SS) for p in pts], fill=255,
               width=max(1, int(round(width * SS))), joint="curve")
        if caps and pts:
            r = max(0.6, width / 2.0)
            for p in (pts[0], pts[-1]):
                d.ellipse([((p[0] - r) * SS, (p[1] - r) * SS),
                           ((p[0] + r) * SS, (p[1] + r) * SS)], fill=255)
        return self._to_np(im)

    def m_arc(self, cx, cy, rx, ry, thick, a0, a1):
        im = self._new()
        ImageDraw.Draw(im).arc(
            [((cx - rx) * SS, (cy - ry) * SS), ((cx + rx) * SS, (cy + ry) * SS)],
            start=a0, end=a1, fill=255, width=max(1, int(round(thick * SS))),
        )
        return self._to_np(im)

    # ---------------- манипуляции с масками ----------------
    def blur(self, mask, radius_design):
        if radius_design <= 0.05:
            return mask
        im = Image.fromarray(clip01(mask).astype(np.float32).__mul__(255).astype(np.uint8), "L")
        return np.asarray(im.filter(ImageFilter.GaussianBlur(radius_design * SS)),
                          np.float32) / 255.0

    def erode(self, mask, width_design):
        k = max(1, int(round(width_design * SS)))
        size = 2 * k + 1
        if size > 15:
            size = 15
        im = Image.fromarray((clip01(mask) * 255.0).astype(np.uint8), "L")
        return np.asarray(im.filter(ImageFilter.MinFilter(size)), np.float32) / 255.0

    def shift(self, mask, dx_design, dy_design):
        dx = int(round(dx_design * SS))
        dy = int(round(dy_design * SS))
        out = np.zeros_like(mask)
        h, w = mask.shape
        xs0, xs1 = max(0, -dx), w - max(0, dx)
        ys0, ys1 = max(0, -dy), h - max(0, dy)
        if xs1 <= xs0 or ys1 <= ys0:
            return out
        out[max(0, dy):max(0, dy) + (ys1 - ys0),
            max(0, dx):max(0, dx) + (xs1 - xs0)] = mask[ys0:ys1, xs0:xs1]
        return out

    @staticmethod
    def bbox(mask, thresh=0.002):
        rows = np.where(mask.max(axis=1) > thresh)[0]
        cols = np.where(mask.max(axis=0) > thresh)[0]
        if rows.size == 0 or cols.size == 0:
            return None
        return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1

    # ---------------- заливки ----------------
    def fill_v(self, c_top, c_bottom, gamma=1.0):
        t = np.linspace(0.0, 1.0, CH, dtype=np.float32)[:, None, None]
        if gamma != 1.0:
            t = t ** gamma
        c_top = np.asarray(c_top, np.float32).reshape(1, 1, 3)
        c_bottom = np.asarray(c_bottom, np.float32).reshape(1, 1, 3)
        self.a[:] = c_top * (1.0 - t) + c_bottom * t

    def over(self, mask, color, alpha=1.0):
        if alpha <= 0.0:
            return
        m = clip01(mask)[..., None] * alpha
        col = np.asarray(color, np.float32).reshape(1, 1, 3)
        self.a *= (1.0 - m)
        self.a += col * m

    def add(self, mask, color, strength=1.0):
        if strength <= 0.0:
            return
        col = np.asarray(color, np.float32).reshape(1, 1, 3)
        self.a += clip01(mask)[..., None] * col * strength

    def darken(self, mask, strength=1.0):
        self.a *= (1.0 - clip01(mask)[..., None] * strength)

    def over_grad(self, mask, c0, c1, direction=(0.0, -1.0), alpha=1.0,
                  lo=0.0, hi=1.0):
        bb = self.bbox(mask)
        if not bb:
            return
        x0, y0, x1, y1 = bb
        sub = clip01(mask[y0:y1, x0:x1])
        ys = np.arange(y0, y1, dtype=np.float32)[:, None]
        xs = np.arange(x0, x1, dtype=np.float32)[None, :]
        dx, dy = direction
        norm = math.hypot(dx, dy) or 1.0
        p = (xs * (dx / norm) + ys * (dy / norm))
        span = float(p.max() - p.min())
        t = (p - float(p.min())) / (span if span > 1e-6 else 1.0)
        t = lo + (hi - lo) * t
        tc = t[..., None]
        c0 = np.asarray(c0, np.float32).reshape(1, 1, 3)
        c1 = np.asarray(c1, np.float32).reshape(1, 1, 3)
        color = c0 * (1.0 - tc) + c1 * tc
        m = sub[..., None] * alpha
        region = self.a[y0:y1, x0:x1]
        region *= (1.0 - m)
        region += color * m

    def add_glow(self, cx, cy, rx, ry, color, strength=1.0, power=2.3, core=0.0):
        if rx <= 0 or ry <= 0 or strength <= 0:
            return
        x0 = max(0, int((cx - rx) * SS))
        x1 = min(CW, int((cx + rx) * SS) + 1)
        y0 = max(0, int((cy - ry) * SS))
        y1 = min(CH, int((cy + ry) * SS) + 1)
        if x1 <= x0 or y1 <= y0:
            return
        xs = (np.arange(x0, x1, dtype=np.float32) + 0.5) / SS
        ys = (np.arange(y0, y1, dtype=np.float32) + 0.5) / SS
        d = np.sqrt(((xs - cx) / rx) ** 2 + ((ys[:, None] - cy) / ry) ** 2)
        fall = np.clip(1.0 - d, 0.0, 1.0) ** power
        if core:
            fall = fall + core * np.exp(-((d * 3.1) ** 2))
        self.a[y0:y1, x0:x1] += fall[..., None] * np.asarray(color, np.float32) * strength

    def rim(self, mask, color, strength=0.5, width=1.4, direction=(0.7, -1.0),
            blur_r=0.7, bias=0.12):
        inner = self.erode(mask, width)
        rim = clip01(mask - inner)
        if blur_r:
            rim = self.blur(rim, blur_r)
        bb = self.bbox(mask)
        if not bb:
            return
        x0, y0, x1, y1 = bb
        ys = np.arange(y0, y1, dtype=np.float32)[:, None]
        xs = np.arange(x0, x1, dtype=np.float32)[None, :]
        dx, dy = direction
        norm = math.hypot(dx, dy) or 1.0
        p = xs * (dx / norm) + ys * (dy / norm)
        span = float(p.max() - p.min())
        t = (p - float(p.min())) / (span if span > 1e-6 else 1.0)
        w = np.clip(bias + (1.0 - bias) * t, 0.0, 1.0)
        self.a[y0:y1, x0:x1] += (
            rim[y0:y1, x0:x1][..., None] * w[..., None]
            * np.asarray(color, np.float32) * strength
        )

    def shadow(self, mask, dx=0.0, dy=6.0, blur_r=10.0, alpha=0.5):
        sh = self.shift(self.blur(mask, blur_r), dx, dy)
        self.a *= (1.0 - clip01(sh)[..., None] * alpha)

    # ---------------- финал ----------------
    def tonemap(self, knee=0.70, headroom=0.30):
        """Мягкое сжатие ярких участков без подъёма теней."""
        over = np.clip(self.a - knee, 0.0, None)
        self.a = np.minimum(self.a, knee) + headroom * (1.0 - np.exp(-over / headroom))

    def vignette(self, strength=0.55, power=2.4):
        xs = (np.arange(CW, dtype=np.float32) / CW - 0.5) * 2.0
        ys = (np.arange(CH, dtype=np.float32) / CH - 0.5) * 2.0
        r = np.sqrt((xs[None, :] * 1.02) ** 2 + (ys[:, None] * 0.94) ** 2) / 1.28
        v = 1.0 - strength * np.clip(r, 0.0, 1.0) ** power
        self.a *= v[..., None]

    def to_image(self):
        arr = np.clip(self.a, 0.0, 1.0) * 255.0 + 0.5
        img = Image.fromarray(arr.astype(np.uint8), "RGB")
        return img.resize((W, H), Image.LANCZOS)


# ---------------------------------------------------------------------------
# Общие фоны, свет, частицы
# ---------------------------------------------------------------------------
def beams(cv: Canvas, origin, angles, length=1250.0, width=120.0, color=WHITE,
          strength=0.12, blur_r=34.0, taper=0.55):
    ox, oy = origin
    for ang in angles:
        rad = math.radians(ang)
        dx, dy = math.cos(rad), math.sin(rad)
        px, py = -dy, dx
        w0 = width * 0.10
        p0 = (ox + px * w0, oy + py * w0)
        p1 = (ox + dx * length + px * width * taper,
              oy + dy * length + py * width * taper)
        p2 = (ox + dx * length - px * width * taper,
              oy + dy * length - py * width * taper)
        p3 = (ox - px * w0, oy - py * w0)
        m = cv.blur(cv.m_poly([p0, p1, p2, p3]), blur_r)
        cv.add(m, color, strength)


def floor_plane(cv: Canvas, p, y=430.0, pool_x=640.0, pool_r=400.0, pool_s=0.30,
                horizon_s=0.14, darken_s=0.30, smear_x=None, smear_s=0.12):
    m = cv.blur(cv.m_rect(-200, y, 1160, 700), 16.0)
    cv.darken(m, darken_s)
    horizon = cv.blur(cv.m_rect(-20, y - 0.6, 980, y + 0.6), 1.1)
    cv.add(horizon, p["accent"], horizon_s)
    cv.add_glow(pool_x, y + 2, pool_r, 46.0, p["glow"], pool_s, power=2.0)
    cv.add_glow(pool_x, y - 1, pool_r * 0.45, 14.0, p["rim"], pool_s * 0.45, power=1.8)
    if smear_x is not None:
        sm = cv.blur(cv.m_ellipse(smear_x, y + 46, 90.0, 90.0), 26.0)
        cv.add(sm, p["accent"], smear_s)


def bokeh(cv: Canvas, rng, n, box, color, r_range=(0.9, 7.0),
          alpha_range=(0.05, 0.30)):
    x0, y0, x1, y1 = box
    for _ in range(n):
        x = x0 + rng.random() * (x1 - x0)
        y = y0 + rng.random() * (y1 - y0)
        r = r_range[0] + (r_range[1] - r_range[0]) * rng.random() ** 2.2
        m = cv.m_ellipse(x, y, r, r)
        if r > 1.6 and rng.random() < 0.75:
            m = cv.blur(m, max(0.8, r * 0.85))
        col = color if rng.random() < 0.7 else mix(color, WHITE, 0.55)
        a = alpha_range[0] + (alpha_range[1] - alpha_range[0]) * rng.random() ** 1.4
        cv.add(m, col, a)


def spec_band(cv: Canvas, cx, cy, w, h, angle, color, strength=0.12, blur_r=8.0):
    """Мягкий блик-полоса (отражение софтбокса)."""
    m = cv.m_ellipse(cx, cy, w, h, angle)
    cv.add(cv.blur(m, blur_r), color, strength)


def backdrop(cv: Canvas, p, *, glow=(650, 220), glow_r=(520, 400), glow_s=0.85,
             glow2=None, glow2_r=(380, 340), glow2_s=0.35,
             corner_s=0.30, beams_origin=(890, -80),
             beams_angles=(-174, -158, -142, -126),
             beams_len=1280.0, beams_w=130.0, beams_s=0.20, beams_blur=22.0,
             beam_color=None, floor_y=430.0, pool=(640, 428.0), pool_r=400.0,
             pool_s=0.45, horizon_s=0.22, floor_darken=0.42, smear=True,
             bokeh_n=26, bokeh_box=(300, 30, 940, 350),
             bokeh_color=None, bokeh_alpha=(0.06, 0.32), bokeh_spot=None):
    cv.fill_v(mix(p["base2"], p["accent"], 0.02) * 0.52, p["base"] * 0.82)
    # ключевой свет из верхнего правого угла
    if corner_s:
        cv.add_glow(W + 130, -150, 780, 640,
                    mix(p["accent"], WHITE, 0.55), corner_s, power=2.0)
    # основной объёмный свет за объектом
    cv.add_glow(glow[0], glow[1], glow_r[0], glow_r[1],
                beam_color or p["glow"], glow_s, power=2.2)
    cv.add_glow(glow[0], glow[1], glow_r[0] * 0.46, glow_r[1] * 0.46,
                mix(p["rim"], p["accent"], 0.40), glow_s * 0.55,
                power=2.0, core=0.12)
    if glow2 is None:
        glow2 = (glow[0] + glow_r[0] * 0.85, glow[1] + glow_r[1] * 0.52)
    if glow2_s:
        cv.add_glow(glow2[0], glow2[1], glow2_r[0], glow2_r[1],
                    p["accent2"], glow2_s, power=2.5)
    if beams_angles:
        beams(cv, beams_origin, beams_angles, length=beams_len, width=beams_w,
              color=beam_color or mix(p["accent"], WHITE, 0.35),
              strength=beams_s, blur_r=beams_blur)
        beams(cv, beams_origin,
              [a + 2.0 for a in beams_angles[::2]],
              length=beams_len * 0.9, width=beams_w * 0.35,
              color=mix(p["rim"], WHITE, 0.5), strength=beams_s * 0.35,
              blur_r=4.0)
    floor_plane(cv, p, y=floor_y, pool_x=pool[0], pool_r=pool_r,
                pool_s=pool_s, horizon_s=horizon_s, darken_s=floor_darken,
                smear_x=pool[0] if smear else None,
                smear_s=0.10)
    rngb = cv.rng
    if bokeh_n:
        bokeh(cv, rngb, bokeh_n, bokeh_box,
              bokeh_color or mix(p["accent"], WHITE, 0.25), alpha_range=bokeh_alpha)
    if bokeh_spot:
        bokeh(cv, rngb, bokeh_spot[0], bokeh_spot[1],
              bokeh_color or mix(p["accent2"], WHITE, 0.25),
              r_range=(0.7, 4.0), alpha_range=(0.04, 0.20))


def sparks(cv: Canvas, rng, n, box, color, s_range=(1.6, 4.2), strength=0.8):
    x0, y0, x1, y1 = box
    for _ in range(n):
        x = x0 + rng.random() * (x1 - x0)
        y = y0 + rng.random() * (y1 - y0)
        s = s_range[0] + (s_range[1] - s_range[0]) * rng.random()
        cv.add_glow(x, y, s * 3.0, s * 3.0, color, strength * 0.35, power=2.6)
        cv.add_glow(x, y, s * 0.9, s * 0.9, mix(color, WHITE, 0.7), strength * 0.8,
                    power=1.7, core=0.5)
        length = s * (2.4 + rng.random() * 2.0)
        cv.add(cv.blur(cv.m_line([(x - length, y), (x + length, y)], 0.7), 0.7),
               mix(color, WHITE, 0.75), strength * 0.45)
        cv.add(cv.blur(cv.m_line([(x, y - length), (x, y + length)], 0.7), 0.7),
               mix(color, WHITE, 0.75), strength * 0.35)


# ---------------------------------------------------------------------------
# Базовые 3D-формы продуктов
# ---------------------------------------------------------------------------
def box3d(cv: Canvas, x, y, w, h, dx, dy, p, *, radius=12.0,
          front=None, front_top=None, front_bot=None, top=None, side=None,
          rim_s=0.85, rim_color=None, rim_dir=(0.7, -1.0), rim_width=1.8,
          edge=None, edge_s=0.6, shadow_alpha=0.45, shadow_blur=12.0,
          shade_v=0.42, spec=0.12, bevel=True):
    """Псевдо-3D параллелепипед: фронт (x,y,w,h) + выдавливание (dx, -dy)."""
    front = mix(p["base2"], WHITE, 0.15) if front is None else front
    front_top = mix(front, WHITE, 0.30) if front_top is None else front_top
    front_bot = mix(front, BLACK, 0.55) if front_bot is None else front_bot
    top = mix(front, WHITE, 0.34) if top is None else top
    side = front * 0.46 if side is None else side
    rim_color = p["rim"] if rim_color is None else rim_color
    edge = mix(p["accent"], WHITE, 0.40) if edge is None else edge

    fm = cv.m_rrect(x + w / 2, y + h / 2, w, h, radius)
    tm = cv.m_poly([(x, y), (x + dx, y - dy), (x + w + dx, y - dy), (x + w, y)])
    sm = cv.m_poly([(x + w, y), (x + w + dx, y - dy),
                    (x + w + dx, y + h - dy), (x + w, y + h)])

    if shadow_alpha:
        cv.shadow(fm, dx=dx * 0.35, dy=dy * 0.55, blur_r=shadow_blur,
                  alpha=shadow_alpha)

    cv.over_grad(sm, side * 1.35, side * 0.55, (0.2, -1.0))
    cv.over_grad(tm, mix(top, WHITE, 0.10), top * 0.62, (-0.6, -0.4))
    cv.over_grad(fm, front_top, front_bot, (0.25, -1.0))

    # блик софтбокса на фронтальной плоскости
    if spec:
        spec_band(cv, x + w * 0.34, y + h * 0.28, w * 0.26, h * 0.55, -28.0,
                  mix(WHITE, p["accent"], 0.25), spec)
        cv.add(cv.blur(cv.m_ellipse(x + w * 0.12, y + h * 0.82,
                                    w * 0.10, h * 0.10), 6.0),
               p["accent"], spec * 0.5)

    # вставная панель-бевел
    if bevel and w > 60 and h > 40:
        inset = min(w, h) * 0.09
        cv.add(cv.blur(cv.m_rrect(x + w / 2, y + h / 2, w - inset * 2,
                                  h - inset * 2, max(3.0, radius - 3.0)), 0.7),
               mix(WHITE, p["accent"], 0.4), 0.055)

    # тонкая подсветка граней, обращённых к свету
    cv.add(cv.blur(cv.m_line([(x + 1.5, y + 1.0), (x + w - 1.5, y + 1.0)], 1.3), 0.7),
           edge, edge_s)
    cv.add(cv.blur(cv.m_line([(x + 1.0, y + 2.0), (x + 1.0, y + h - 2.0)], 1.2), 0.7),
           mix(edge, WHITE, 0.25), edge_s * 0.55)
    # светлая кромка верхней грани
    cv.add(cv.blur(cv.m_line([(x + dx, y - dy + 1.0),
                              (x + w + dx, y - dy + 1.0)], 1.4), 0.8),
           mix(edge, WHITE, 0.55), edge_s * 0.85)
    cv.add(cv.blur(cv.m_line([(x + w + dx - 1.0, y - dy + 2.0),
                              (x + w - 1.0, y + 2.0)], 1.1), 0.7),
           mix(edge, WHITE, 0.40), edge_s * 0.6)

    silhouette = clip01(fm + tm + sm)
    cv.rim(silhouette, rim_color, rim_s, width=rim_width,
           direction=rim_dir, blur_r=0.8)
    return {"front": fm, "top": tm, "side": sm, "sil": silhouette,
            "x": x, "y": y, "w": w, "h": h, "dx": dx, "dy": dy}


def cylinder(cv: Canvas, cx, cy, w, h, p, *, body_top=None, body_bot=None,
             cap=None, cap_ratio=0.16, rim_s=0.5, rim_color=None, shadow_a=0.45):
    body_top = mix(p["base2"], WHITE, 0.13) if body_top is None else body_top
    body_bot = body_top * 0.42 if body_bot is None else body_bot
    cap = mix(body_top, WHITE, 0.28) if cap is None else cap
    rim_color = p["rim"] if rim_color is None else rim_color
    r = w * 0.42
    cy_cap = cy - h / 2 + w * cap_ratio * 0.5
    body = cv.m_rrect(cx, cy + w * 0.03, w, h - w * 0.05, r)
    cap_m = cv.m_ellipse(cx, cy - h / 2 + w * cap_ratio * 0.55, w / 2, w * cap_ratio)
    cv.shadow(body, dx=3, dy=8, blur_r=10, alpha=shadow_a)
    cv.over_grad(body, body_top, body_bot, (0.85, -0.2))
    cv.over_grad(cap_m, mix(cap, WHITE, 0.15), cap * 0.7, (-0.4, 0.6))
    cv.rim(clip01(body + cap_m), rim_color, rim_s, width=1.3,
           direction=(-1.0, -0.7), blur_r=0.9)
    # боковой блик
    gloss = cv.blur(cv.m_ellipse(cx - w * 0.26, cy, w * 0.09, h * 0.42), 2.4)
    cv.add(gloss, mix(WHITE, p["accent"], 0.2), 0.10)
    return {"body": body, "cap": cap_m, "cx": cx, "cy": cy, "w": w, "h": h}


def usbc(cv: Canvas, cx, cy, angle, scale, p, *, body=None, slot=True,
         tip_color=None):
    """Разъём USB-C: металлический корпус + тёмный слот."""
    body = mix(p["base2"], WHITE, 0.22) if body is None else body
    tip_color = p["rim"] if tip_color is None else tip_color
    w, h = 56.0 * scale, 22.0 * scale
    shell = cv.m_rrect(cx, cy, w, h, 7.0 * scale, angle)
    inner = cv.m_rrect(cx + 1.0 * scale, cy, w - 8.0 * scale, h - 8.0 * scale,
                       4.5 * scale, angle)
    cv.shadow(shell, 2, 4, 5, 0.35)
    cv.over_grad(shell, mix(body, WHITE, 0.35), body * 0.45,
                 (-0.3, -1.0))
    cv.rim(shell, tip_color, 0.75, width=1.2, direction=(-0.8, -1.0), blur_r=0.6)
    if slot:
        a = math.radians(angle)
        ex, ey = math.cos(a) * (w / 2 - 6 * scale), math.sin(a) * (w / 2 - 6 * scale)
        cv.add(cv.blur(cv.m_line([(cx - ex, cy - ey), (cx + ex, cy + ey)],
                                 max(1.2, 2.2 * scale)), 0.8),
               mix(BLACK, p["accent"], 0.25), 0.9)
        cv.add(cv.blur(cv.m_ellipse(cx - ex * 0.35, cy - ey * 0.35,
                                    2.0 * scale, 1.4 * scale), 0.5),
               tip_color, 0.5)
    return shell


def cable(cv: Canvas, pts, width, color, *, core=None, highlight=True,
          strength=1.0):
    """Трубка кабеля с тёмной оболочкой и бликом."""
    core = mix(color, WHITE, 0.55) if core is None else core
    base = cv.m_line(pts, width, caps=True)
    cv.over(base, mix(color, BLACK, 0.55), 0.95)
    cv.over(cv.m_line(pts, width * 0.72, caps=True), color, 1.0)
    if highlight:
        shifted = [(x - width * 0.16, y - width * 0.22) for x, y in pts]
        cv.add(cv.blur(cv.m_line(shifted, width * 0.20, caps=True), 0.6),
               core, 0.55 * strength)
        cv.add(cv.blur(cv.m_line([(x + width * 0.10, y + width * 0.34)
                                  for x, y in pts], width * 0.10), 1.2),
               BLACK, 0.25)
    return base


def contact_glow(cv: Canvas, cx, cy, rx, ry, color, strength=0.35):
    cv.add_glow(cx, cy, rx, ry, color, strength, power=2.2)


# ---------------------------------------------------------------------------
# Текст обложки
# ---------------------------------------------------------------------------
LABEL = "MONEYFORUP \u2022 CASE"
LABEL_TRACK = 2.05   # дизайнерские px


def _text_width(draw, text, face):
    return draw.textlength(text, font=face) / SS


def draw_cover_text(cv: Canvas, name: str, accent, rim):
    """Подпись внизу слева: верхний мелкий label + крупное имя кейса."""
    probe = ImageDraw.Draw(Image.new("L", (4, 4)))

    # акцентный штрих
    tick = cv.m_rrect(59.0, 438.0, 22.0, 2.3, 1.15)
    cv.add(cv.blur(tick, 1.1), accent, 0.6)

    # label с трекингом
    face = font(11.5 * SS)
    label_im = cv._new()
    ld = ImageDraw.Draw(label_im)
    xx = 48.0
    for ch in LABEL:
        ld.text((xx * SS, 458.0 * SS), ch, font=face, fill=255, anchor="ls")
        xx += _text_width(probe, ch, face) + LABEL_TRACK
    label_mask = cv._to_np(label_im)
    cv.darken(cv.shift(cv.blur(label_mask, 1.6), 0.0, 1.4), 0.35)
    cv.add(label_mask, mix(accent, WHITE, 0.42), 0.92)

    # имя кейса, вписанное по ширине
    size = 40.0
    face = font(size * SS)
    width = _text_width(probe, name, face)
    while width > 424.0 and size > 25.0:
        size -= 1.0
        face = font(size * SS)
        width = _text_width(probe, name, face)

    name_im = cv._new()
    ImageDraw.Draw(name_im).text((48.0 * SS, 510.0 * SS), name, font=face,
                                 fill=255, anchor="ls")
    name_mask = cv._to_np(name_im)
    cv.darken(cv.shift(cv.blur(name_mask, 2.8), 0.0, 2.2), 0.55)
    cv.over_grad(name_mask, mix(WHITE, rim, 0.25), mix(WHITE, rim, 0.62),
                 (0.0, -1.0), alpha=1.0, lo=0.0, hi=1.0)


def text_scrim(cv: Canvas, p):
    """Мягкое затемнение под подписью, чтобы текст читался на любом фоне."""
    spot = cv.blur(cv.m_ellipse(150.0, 512.0, 470.0, 230.0), 70.0)
    cv.darken(spot, 0.46)
    strip = cv.blur(cv.m_rect(-80, 440, 1040, 660), 30.0)
    cv.darken(strip, 0.34)


# ---------------------------------------------------------------------------
# Финальная обработка и сохранение
# ---------------------------------------------------------------------------
def add_grain(img: Image.Image, seed: int, amount=2.0, chroma=0.30):
    arr = np.asarray(img, np.float32) / 255.0
    rng = np.random.default_rng(seed ^ 0x5EED)
    lum = arr.mean(axis=2, keepdims=True)
    weight = 0.35 + 0.65 * lum
    mono = rng.standard_normal((H, W)).astype(np.float32) * (amount / 255.0)
    arr = arr + mono[..., None] * weight
    color = rng.standard_normal((H, W, 3)).astype(np.float32) * (chroma * amount / 255.0)
    arr = arr + color * weight
    return Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")


def save_cover(img: Image.Image, path: Path, quality: int) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    q = quality
    while True:
        img.save(path, "JPEG", quality=q, optimize=True, progressive=True,
                 subsampling=2)
        size = path.stat().st_size
        if size <= MAX_BYTES or q <= 68:
            return size
        q -= 3


# ---------------------------------------------------------------------------
# CASES — единственный источник правды: id -> палитра/мотив
# ---------------------------------------------------------------------------
def case(name, price, motif, accent, accent2, base, base2, rim):
    return {
        "name": name,
        "price": price,
        "motif": motif,
        "accent": hx(accent),
        "accent2": hx(accent2),
        "base": hx(base),
        "base2": hx(base2),
        "rim": hx(rim),
        "glow": mix(hx(accent), hx(accent2), 0.35),
    }


CASES = {
    # --- классические кейсы ---
    "case_500": case("Стартовый дроп", 500, "steel_cables",
                     "#7fb0e8", "#cfd9e6", "#05070b", "#111820", "#dbe9ff"),
    "case_750": case("Кабели и адаптеры", 750, "cable_adapters",
                     "#2fd4ff", "#2f7bff", "#03070f", "#0a1626", "#c9f2ff"),
    "case_1000": case("Домашний уют", 1000, "smart_home",
                      "#ffb15c", "#ff7a3c", "#0a0705", "#1b120b", "#ffe0b4"),
    "case_1500": case("Смарт-свет", 1500, "smart_light",
                      "#a26bff", "#49e0ff", "#06050f", "#131026", "#ecdcff"),
    "case_2000": case("Портативное аудио", 2000, "portable_audio",
                      "#8b5cf6", "#3b82f6", "#05060e", "#0f1026", "#d5ddff"),
    "case_2500": case("Авто-гаджеты", 2500, "auto_gadgets",
                      "#ff4d3d", "#ff9a2e", "#0a0505", "#1c0c08", "#ffcfae"),
    "case_3000": case("Геймерский старт", 3000, "gamer_start",
                      "#ff3ec8", "#35e6ff", "#06050c", "#140a1e", "#ffd8f6"),
    "case_4000": case("Умная кухня", 4000, "smart_kitchen",
                      "#ff8a3c", "#ffc46b", "#0a0704", "#1d1209", "#ffe4b8"),
    "case_5000": case("Гаджет-бокс", 5000, "gadget_box",
                      "#22d3c5", "#2f95ff", "#03090b", "#0a1a20", "#ccfff8"),
    "case_6000": case("Смарт-комфорт", 6000, "smart_comfort",
                      "#ff6fa5", "#ff9fc9", "#0b0608", "#1d0e15", "#ffdceb"),
    "case_7000": case("Кибер-стрим", 7000, "cyber_stream",
                      "#b44dff", "#ff3d5a", "#07050d", "#150a1e", "#ecdcff"),
    "case_8000": case("Премиум аудио", 8000, "premium_audio",
                      "#ffcc66", "#9b5cff", "#07060a", "#181121", "#ffedc0"),
    "case_9000": case("Про-девайсы", 9000, "pro_devices",
                      "#3b8bff", "#35d9ff", "#03070f", "#091a2c", "#d4ebff"),
    "case_9500": case("Ультра-сетап", 9500, "ultra_setup",
                      "#ff3b5c", "#3b6bff", "#06050b", "#140a18", "#ffd6dc"),
    "case_10000": case("Флагманский люкс", 10000, "flagship_luxury",
                       "#ffd27a", "#b58a3c", "#060505", "#15110b", "#fff0c8"),
    # --- новые режимы ---
    "starter_drop": case("STARTER DROP", 250, "starter_crate",
                         "#d8e2ef", "#8fb3d9", "#05070a", "#11161d", "#f2f8ff"),
    "cyber_rush": case("CYBER RUSH", 750, "cyber_crate",
                       "#35d6ff", "#a855f7", "#04060f", "#0b1024", "#cdf6ff"),
    "golden_vault": case("GOLDEN VAULT", 3500, "golden_vault",
                         "#ffd76a", "#b8860b", "#070604", "#17120a", "#ffedb4"),
    "glitch_mode": case("GLITCH MODE", 11000, "glitch_crate",
                        "#ff2e4d", "#ff7a90", "#050507", "#15070b", "#ffd4dc"),
    "omega_core": case("OMEGA CORE", 35000, "omega_core",
                       "#a78bfa", "#e2e8f0", "#06050b", "#130f20", "#f4eeff"),
}


# ---------------------------------------------------------------------------
# СЦЕНЫ (по одной функции на мотив, композиции различаются)
# ---------------------------------------------------------------------------
def _stage(cv, p, glow=(660, 235), pool=(640, 430), **kw):
    """Общая сцена: фон, свет, пол и лёгкая пыль."""
    kw.setdefault("glow_r", (520, 390))
    kw.setdefault("glow_s", 0.92)
    kw.setdefault("pool_r", 390)
    kw.setdefault("pool_s", 0.46)
    backdrop(cv, p, glow=glow, pool=pool, **kw)


def scene_steel_cables(cv, p):
    _stage(cv, p, glow=(690, 220), pool=(650, 432))
    box3d(cv, 585, 245, 210, 142, 42, 30, p, radius=18, rim_s=0.95)
    cable(cv, [(420, 405), (500, 355), (565, 398), (640, 330), (724, 365)],
          17, p["accent"])
    usbc(cv, 730, 360, -26, 1.45, p)
    usbc(cv, 452, 405, 14, 1.05, p)
    for i in range(3):
        cv.add(cv.blur(cv.m_line([(600 + i * 18, 282), (640 + i * 18, 282)], 1.4), .6),
               p["rim"], .35)
    sparks(cv, cv.rng, 12, (420, 290, 770, 435), p["accent2"], strength=.45)


def scene_cable_adapters(cv, p):
    _stage(cv, p, glow=(700, 225), pool=(660, 430),
           beams_angles=(-168, -150, -132))
    cable(cv, [(390, 390), (450, 320), (535, 355), (590, 285), (675, 325),
               (730, 265)], 20, p["accent"])
    cable(cv, [(470, 430), (540, 385), (610, 420), (690, 380)], 13, p["accent2"])
    usbc(cv, 745, 250, -18, 1.8, p)
    usbc(cv, 392, 392, 20, 1.25, p)
    usbc(cv, 675, 380, -10, 1.0, p)
    sparks(cv, cv.rng, 22, (390, 250, 800, 430), p["accent"], strength=.7)


def scene_smart_home(cv, p):
    _stage(cv, p, glow=(655, 230), pool=(640, 432))
    box3d(cv, 590, 255, 180, 125, 36, 26, p, radius=22, rim_s=.8)
    cylinder(cv, 500, 365, 86, 120, p, cap_ratio=.18)
    usbc(cv, 690, 350, -6, 1.1, p)
    cv.add_glow(650, 320, 40, 12, p["accent"], .55, power=2.1)
    sparks(cv, cv.rng, 8, (470, 280, 760, 420), p["accent2"], strength=.35)


def scene_smart_light(cv, p):
    _stage(cv, p, glow=(650, 245), glow_s=1.15, pool=(640, 430))
    bulb = cv.m_ellipse(650, 285, 92, 108)
    cv.over_grad(bulb, mix(p["accent"], WHITE, .35), mix(p["accent2"], WHITE, .05),
                 (-.3, -1.0))
    cv.add_glow(650, 285, 150, 160, p["accent"], .75, power=2.0, core=.2)
    cv.over(cv.m_ring(650, 285, 112, 128, 2.0), p["rim"], .8)
    cylinder(cv, 650, 390, 74, 46, p, cap_ratio=.24)
    for y, off in ((350, 0), (365, 20), (380, -16)):
        cv.add(cv.blur(cv.m_line([(735 + off, y), (850, y - 18)], 4.0), 2.4),
               p["accent2"], .38)
    sparks(cv, cv.rng, 16, (520, 180, 820, 400), p["accent2"], strength=.55)


def scene_portable_audio(cv, p):
    _stage(cv, p, glow=(680, 240), pool=(650, 430))
    cv.add(cv.blur(cv.m_arc(650, 285, 120, 150, 16, 200, 340), 1.2),
           mix(p["base2"], WHITE, .35), .9)
    for cx in (555, 745):
        cylinder(cv, cx, 320, 76, 118, p, cap_ratio=.2)
    box3d(cv, 590, 330, 190, 96, 32, 22, p, radius=18, rim_s=.85)
    cv.add_glow(650, 320, 55, 30, p["accent"], .35, power=2.2)
    sparks(cv, cv.rng, 10, (500, 260, 800, 410), p["accent2"], strength=.4)


def scene_auto_gadgets(cv, p):
    _stage(cv, p, glow=(650, 250), pool=(640, 432),
           beams_angles=(-172, -154, -136))
    box3d(cv, 510, 300, 270, 90, 70, 34, p, radius=28, rim_s=1.0)
    for cx in (565, 725):
        cylinder(cv, cx, 405, 58, 58, p, cap_ratio=.32)
    box3d(cv, 640, 245, 100, 58, 24, 16, p, radius=12, rim_s=.8)
    cv.add_glow(690, 275, 36, 9, p["accent"], .5, power=2.2)
    sparks(cv, cv.rng, 14, (490, 240, 800, 420), p["accent2"], strength=.5)


def scene_gamer_start(cv, p):
    _stage(cv, p, glow=(655, 240), pool=(650, 430))
    kb = box3d(cv, 500, 320, 300, 92, 44, 22, p, radius=12, rim_s=.9)
    for r in range(3):
        for c in range(8):
            x = 512 + c * 34
            y = 334 + r * 22
            cv.add(cv.m_rrect(x, y, 25, 15, 3), mix(p["accent"], WHITE, .25), .5)
    mouse = cv.m_ellipse(690, 380, 44, 30)
    cv.over_grad(mouse, mix(p["accent2"], WHITE, .25), p["base2"], (-.4, -1.0))
    cv.rim(mouse, p["rim"], .7, 1.4)
    cv.add_glow(725, 330, 26, 12, p["accent"], .45, power=2.2)
    sparks(cv, cv.rng, 18, (480, 260, 800, 420), p["accent2"], strength=.6)


def scene_smart_kitchen(cv, p):
    _stage(cv, p, glow=(660, 230), pool=(640, 430))
    box3d(cv, 585, 235, 160, 190, 34, 26, p, radius=18, rim_s=.9)
    cylinder(cv, 545, 390, 54, 52, p, cap_ratio=.3)
    cylinder(cv, 690, 395, 62, 40, p, cap_ratio=.28)
    cv.add(cv.blur(cv.m_line([(660, 260), (660, 380)], 3), 1.2), p["accent"], .35)
    sparks(cv, cv.rng, 12, (500, 250, 780, 420), p["accent2"], strength=.4)


def scene_gadget_box(cv, p):
    _stage(cv, p, glow=(660, 225), pool=(650, 430))
    box3d(cv, 600, 250, 170, 150, 36, 26, p, radius=18, rim_s=.9)
    cv.over_grad(cv.m_ellipse(500, 330, 46, 42), mix(p["accent"], WHITE, .25),
                 p["base2"], (-.4, -1.0))
    cv.over(cv.m_ring(500, 330, 52, 48, 3), p["rim"], .65)
    cylinder(cv, 705, 390, 44, 54, p, cap_ratio=.3)
    for cx in (470, 530):
        cylinder(cv, cx, 390, 24, 30, p, cap_ratio=.35)
    sparks(cv, cv.rng, 14, (450, 270, 790, 420), p["accent2"], strength=.45)


def scene_smart_comfort(cv, p):
    _stage(cv, p, glow=(650, 240), pool=(640, 430))
    cylinder(cv, 590, 300, 120, 180, p, cap_ratio=.14)
    for i in range(5):
        x = 590 + (i - 2) * 14
        cv.add(cv.blur(cv.m_ellipse(x, 200 - i * 8, 18 + i * 5, 46 + i * 8), 6),
               p["accent2"], .18)
    box3d(cv, 645, 330, 120, 70, 24, 18, p, radius=14, rim_s=.8)
    cv.add_glow(590, 250, 48, 22, p["accent"], .4, power=2.2)
    sparks(cv, cv.rng, 10, (500, 200, 780, 420), p["accent"], strength=.4)


def scene_cyber_stream(cv, p):
    _stage(cv, p, glow=(650, 230), pool=(640, 430),
           beams_angles=(-170, -150, -130))
    cv.over(cv.m_ring(560, 250, 120, 120, 12), p["accent"], .45)
    cylinder(cv, 650, 330, 58, 170, p, cap_ratio=.2)
    box3d(cv, 585, 255, 130, 70, 28, 18, p, radius=14, rim_s=.85)
    for i, ang in enumerate((-156, -136, -116)):
        cv.add(cv.blur(cv.m_line([(700, 300),
                                  (700 + math.cos(math.radians(ang)) * 160,
                                   300 + math.sin(math.radians(ang)) * 160)], 2.5), 2),
               p["accent2"], .35)
    sparks(cv, cv.rng, 20, (450, 180, 820, 420), p["accent"], strength=.7)


def scene_premium_audio(cv, p):
    _stage(cv, p, glow=(680, 230), pool=(650, 430))
    box3d(cv, 585, 270, 190, 150, 40, 30, p, radius=20, rim_s=1.0)
    for cx in (620, 740):
        cv.over(cv.m_ring(cx, 335, 30, 30, 5), p["accent"], .7)
        cv.add_glow(cx, 335, 22, 22, p["accent2"], .35, power=2.0)
    cv.add(cv.blur(cv.m_arc(650, 230, 110, 90, 12, 200, 340), 1.2),
           mix(p["rim"], WHITE, .3), .8)
    sparks(cv, cv.rng, 10, (540, 230, 800, 420), p["accent2"], strength=.4)


def scene_pro_devices(cv, p):
    _stage(cv, p, glow=(660, 230), pool=(650, 430))
    box3d(cv, 500, 300, 280, 18, 56, 20, p, radius=8, rim_s=.9,
          front_top=mix(p["base2"], WHITE, .2))
    screen = cv.m_rrect(640, 305, 150, 94, 5, -8)
    cv.over_grad(screen, mix(p["accent"], WHITE, .15), p["base"], (-.4, -1.0))
    for i in range(5):
        cv.add(cv.m_line([(580 + i * 18, 338), (580 + i * 18, 344)], 2),
               p["accent2"], .45)
    usbc(cv, 520, 392, 0, 1.0, p)
    for x in (750, 770):
        cv.add(cv.blur(cv.m_line([(x, 300), (x + 12, 250)], 4), 1.6),
               p["accent"], .55)
    sparks(cv, cv.rng, 10, (480, 240, 820, 420), p["accent2"], strength=.45)


def scene_ultra_setup(cv, p):
    _stage(cv, p, glow=(660, 220), pool=(650, 430))
    cv.over_grad(cv.m_rrect(650, 295, 300, 150, 12), mix(p["base2"], WHITE, .18),
                 p["base"], (-.3, -1.0))
    cv.over_grad(cv.m_rrect(650, 295, 274, 126, 8),
                 mix(p["accent"], WHITE, .12), p["accent2"], (-.6, -1.0))
    cv.add_glow(650, 295, 100, 40, p["accent"], .28, power=2.2)
    box3d(cv, 560, 365, 120, 34, 22, 12, p, radius=8, rim_s=.7)
    for x in (770, 790):
        cv.add(cv.blur(cv.m_line([(x, 360), (x + 14, 320)], 3), 1.2),
               p["accent2"], .4)
    sparks(cv, cv.rng, 12, (480, 210, 820, 420), p["accent2"], strength=.5)


def scene_flagship_luxury(cv, p):
    _stage(cv, p, glow=(670, 230), pool=(650, 430))
    box3d(cv, 590, 230, 150, 190, 30, 26, p, radius=24, rim_s=1.0)
    cv.over_grad(cv.m_ellipse(760, 350, 42, 48), mix(p["accent"], WHITE, .25),
                 p["base2"], (-.5, -1.0))
    cv.over(cv.m_ring(760, 350, 48, 54, 3), p["rim"], .7)
    box3d(cv, 520, 360, 170, 20, 34, 14, p, radius=6, rim_s=.7)
    cv.add_glow(665, 280, 36, 70, p["accent"], .3, power=2.0)
    sparks(cv, cv.rng, 12, (500, 230, 800, 420), p["accent"], strength=.45)


def scene_starter_crate(cv, p):
    _stage(cv, p, glow=(650, 240), glow_s=.8, pool=(640, 430))
    box3d(cv, 565, 250, 210, 165, 38, 28, p, radius=18, rim_s=1.0)
    for i in range(4):
        cv.add(cv.blur(cv.m_line([(590 + i * 44, 275), (590 + i * 44, 395)], 2), 1),
               p["accent2"], .35)
    cv.add_glow(670, 330, 52, 34, p["accent"], .38, power=2.2)
    sparks(cv, cv.rng, 10, (520, 260, 800, 420), p["accent2"], strength=.4)


def scene_cyber_crate(cv, p):
    _stage(cv, p, glow=(660, 230), pool=(650, 430),
           beams_angles=(-168, -150, -132))
    box3d(cv, 570, 250, 200, 160, 38, 28, p, radius=18, rim_s=1.0)
    for i in range(6):
        y = 280 + i * 22
        cv.add(cv.blur(cv.m_line([(575, y), (770, y)], 2), .8),
               p["accent"], .45)
        cv.add(cv.m_rect(575, y - 1, 590, y + 1), p["accent2"], .65)
    cv.add_glow(670, 330, 60, 40, p["accent"], .4, power=2.0)
    sparks(cv, cv.rng, 22, (520, 240, 810, 420), p["accent2"], strength=.7)


def scene_golden_vault(cv, p):
    _stage(cv, p, glow=(660, 230), pool=(650, 430))
    cv.over_grad(cv.m_rrect(660, 310, 230, 210, 26), mix(p["base2"], WHITE, .18),
                 p["base"], (-.4, -1.0))
    cv.over(cv.m_ring(660, 310, 78, 78, 10), p["accent"], .55)
    cv.over(cv.m_ring(660, 310, 46, 46, 5), p["accent2"], .7)
    for ang in range(0, 360, 60):
        a = math.radians(ang)
        cv.add(cv.m_line([(660 + math.cos(a) * 92, 310 + math.sin(a) * 92),
                          (660 + math.cos(a) * 112, 310 + math.sin(a) * 112)], 3),
               p["rim"], .6)
    cv.add_glow(660, 310, 60, 60, p["accent"], .35, power=1.9)
    sparks(cv, cv.rng, 18, (520, 200, 800, 430), p["accent"], strength=.65)


def scene_glitch_crate(cv, p):
    _stage(cv, p, glow=(660, 235), pool=(650, 430))
    box3d(cv, 565, 250, 210, 165, 38, 28, p, radius=14, rim_s=1.0)
    for i, y in enumerate((280, 320, 360, 395)):
        off = (i % 2) * 9
        cv.add(cv.blur(cv.m_rect(540 + off, y, 810 + off, y + 4), 1.2),
               p["accent"], .35)
        cv.add(cv.m_rect(540 + off, y + 4, 810 + off, y + 6),
               p["accent2"], .5)
    for i in range(8):
        x = 535 + cv.rng.random() * 260
        y = 250 + cv.rng.random() * 150
        cv.add(cv.m_rect(x, y, x + 24 + cv.rng.random() * 40, y + 3),
               mix(p["accent2"], WHITE, .25), .55)
    sparks(cv, cv.rng, 24, (500, 230, 820, 430), p["accent"], strength=.75)


def scene_omega_core(cv, p):
    _stage(cv, p, glow=(660, 235), pool=(650, 430))
    cv.over_grad(cv.m_rrect(660, 315, 230, 190, 30), mix(p["base2"], WHITE, .12),
                 p["base"], (-.4, -1.0))
    for r, a in ((120, .25), (90, .35), (60, .5)):
        cv.add(cv.blur(cv.m_ring(660, 300, r, r * .55, 2.0), 1.4),
               p["accent"], a)
    cv.add_glow(660, 300, 58, 54, mix(p["accent"], WHITE, .25), .65, power=2.0,
                core=.25)
    for ang in (20, 110, 200, 290):
        a = math.radians(ang)
        cv.add(cv.blur(cv.m_line([(660 + math.cos(a) * 105, 300 + math.sin(a) * 58),
                                  (660 + math.cos(a) * 150, 300 + math.sin(a) * 88)], 2.5), 1.5),
               p["rim"], .5)
    sparks(cv, cv.rng, 18, (520, 210, 810, 430), p["accent2"], strength=.6)


SCENES = {
    "steel_cables": scene_steel_cables,
    "cable_adapters": scene_cable_adapters,
    "smart_home": scene_smart_home,
    "smart_light": scene_smart_light,
    "portable_audio": scene_portable_audio,
    "auto_gadgets": scene_auto_gadgets,
    "gamer_start": scene_gamer_start,
    "smart_kitchen": scene_smart_kitchen,
    "gadget_box": scene_gadget_box,
    "smart_comfort": scene_smart_comfort,
    "cyber_stream": scene_cyber_stream,
    "premium_audio": scene_premium_audio,
    "pro_devices": scene_pro_devices,
    "ultra_setup": scene_ultra_setup,
    "flagship_luxury": scene_flagship_luxury,
    "starter_crate": scene_starter_crate,
    "cyber_crate": scene_cyber_crate,
    "golden_vault": scene_golden_vault,
    "glitch_crate": scene_glitch_crate,
    "omega_core": scene_omega_core,
}


# ---------------------------------------------------------------------------
# Рендер одного кейса
# ---------------------------------------------------------------------------
def render_case(case_id: str, cfg: dict) -> Image.Image:
    seed = zlib.crc32(case_id.encode("utf-8")) & 0xFFFFFFFF
    cv = Canvas(seed)
    scene = SCENES[cfg["motif"]]
    scene(cv, cfg)
    cv.tonemap(1.32)
    cv.vignette(strength=0.55, power=2.5)
    # Текст на обложке не рисуем: название и цена уже есть в UI-карточке/hero,
    # иначе в hero получался дубль названия. Обложка — чистая «фотография».
    img = cv.to_image()
    return add_grain(img, seed, amount=2.0, chroma=0.30)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Generate MoneyForUp case cover images (960x540 JPEG).")
    parser.add_argument("--only", nargs="*", default=None,
                        help="case ids to render (default: all)")
    parser.add_argument("--out-root", default=None,
                        help="alternative root instead of the repo root")
    parser.add_argument("--no-public", action="store_true",
                        help="write only assets/cases, skip public/assets/cases")
    parser.add_argument("--quality", type=int, default=JPEG_QUALITY)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    root = Path(args.out_root).resolve() if args.out_root else Path(__file__).resolve().parent.parent
    ids = list(CASES.keys()) if not args.only else [i for i in args.only if i in CASES]
    missing = [i for i in (args.only or []) if i not in CASES]
    if missing:
        print("Unknown case ids: " + ", ".join(missing), file=sys.stderr)
        return 2

    total = 0
    rows = []
    for case_id in ids:
        cfg = CASES[case_id]
        img = render_case(case_id, cfg)
        targets = [root / "assets" / "cases" / f"{case_id}.jpg"]
        if not args.no_public:
            targets.append(root / "public" / "assets" / "cases" / f"{case_id}.jpg")
        size = 0
        for target in targets:
            size = save_cover(img, target, args.quality)
        total += 1
        rows.append((case_id, cfg["name"], size))
        print(f"[{total:02d}/{len(ids)}] {case_id:<13} {size / 1024:6.1f} KB  {cfg['name']}")

    print(f"\nГотово: {total} обложек, {total * (1 if args.no_public else 2)} файлов")
    print(f"Корень: {root}")
    worst = max(r[2] for r in rows) if rows else 0
    print(f"Максимальный размер: {worst / 1024:.1f} KB (лимит {MAX_BYTES / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
