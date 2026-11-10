#!/usr/bin/env python3
"""How still do shadow edges stand from frame to frame?

  python3 scripts/shadow-stability.py <prefix> [--roi x0,y0,x1,y1] [--n frames]

Reads <prefix>-0.png, <prefix>-1.png, ... (scripts/shot.cjs --seq), ideally captured with a camera
rigidly attached to a car (followCam) and the ?shadowmask debug view (white matte surfaces lit by
the sun alone), where the car and its shadow should not move by a pixel:

  node scripts/shot.cjs out/m.png '?drive&autopilot&q=high&shadowmask&nograss&notrees' --size 640x360 \
      --eval 'for (let i = 0; i < 420; i++) window.speed.game.update(1 / 60); followCam(5, 3, 0, 40, 0.3)' --frames 14 --seq 6

For every pair of consecutive frames it reports
  - the mean and the largest absolute difference of the luminance (8 bit levels) in the region;
  - the displacement of the shadow edges in pixels: every row and every column is searched for the
    places where the luminance crosses the level halfway between shadow and light (sub-pixel, by
    linear interpolation), each crossing is matched with the nearest one of the same direction in the
    next frame (within 4 px), and the mean, the 95th percentile and the maximum of those distances are
    printed, with the number of crossings that found no partner (edges that appeared or vanished).
"""
import sys
import numpy as np
from PIL import Image


def load(path, roi):
    im = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
    lum = im[..., 0] * 0.2126 + im[..., 1] * 0.7152 + im[..., 2] * 0.0722
    if roi:
        x0, y0, x1, y1 = roi
        lum = lum[y0:y1, x0:x1]
    return lum


def crossings(lum, level):
    """Sub-pixel positions where each row crosses `level`: list per row of (x, direction)."""
    a, b = lum[:, :-1], lum[:, 1:]
    up = (a < level) & (b >= level)
    down = (a >= level) & (b < level)
    out = []
    for y in range(lum.shape[0]):
        row = []
        for mask, d in ((up, 1), (down, -1)):
            xs = np.nonzero(mask[y])[0]
            for x in xs:
                den = b[y, x] - a[y, x]
                row.append((x + (level - a[y, x]) / den if den != 0 else x + 0.5, d))
        out.append(row)
    return out


def displacement(c0, c1, reach=4.0):
    ds, lost = [], 0
    for r0, r1 in zip(c0, c1):
        for x, d in r0:
            best = None
            for x2, d2 in r1:
                if d2 == d and (best is None or abs(x2 - x) < abs(best)):
                    best = x2 - x
            if best is None or abs(best) > reach:
                lost += 1
            else:
                ds.append(abs(best))
    return ds, lost


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    prefix = args[0]
    roi = None
    n = 64
    if '--roi' in args:
        roi = [int(v) for v in args[args.index('--roi') + 1].split(',')]
    if '--n' in args:
        n = int(args[args.index('--n') + 1])
    frames = []
    for i in range(n):
        try:
            frames.append(load(f'{prefix}-{i}.png', roi))
        except FileNotFoundError:
            break
    if len(frames) < 2:
        print('need at least two frames')
        sys.exit(1)
    lo, hi = np.percentile(frames[0], 4), np.percentile(frames[0], 96)
    level = (lo + hi) / 2
    print(f'{prefix}: {len(frames)} frames, shadow {lo:.0f} / light {hi:.0f}, edge level {level:.0f}')
    all_d, all_lost, all_mean, all_max = [], 0, [], []
    for i in range(len(frames) - 1):
        f0, f1 = frames[i], frames[i + 1]
        diff = np.abs(f1 - f0)
        ds = []
        lost = 0
        # rows (horizontal displacement) and columns (vertical displacement)
        for a, b in ((f0, f1), (f0.T, f1.T)):
            d, l = displacement(crossings(a, level), crossings(b, level))
            ds += d
            lost += l
        ds = np.array(ds) if ds else np.zeros(1)
        all_d.append(ds)
        all_lost += lost
        all_mean.append(diff.mean())
        all_max.append(diff.max())
        print(f'  {i}->{i + 1}: diff mean {diff.mean():6.3f} max {diff.max():5.1f} | edge shift mean {ds.mean():.3f} p95 {np.percentile(ds, 95):.3f} max {ds.max():.3f} px ({len(ds)} crossings, {lost} unmatched)')
    d = np.concatenate(all_d)
    print(f'  all: diff mean {np.mean(all_mean):.3f} max {np.max(all_max):.1f} | edge shift mean {d.mean():.3f} p95 {np.percentile(d, 95):.3f} max {d.max():.3f} px, {all_lost} unmatched')


if __name__ == '__main__':
    main()
