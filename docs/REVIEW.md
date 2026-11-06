# SPEED — strict review against Gran Turismo 7 (November 2026)

This is the bar the owner set: AAA, on par with or beyond GT7. Scores are out of 10 against GT7 on a
PS5 (10 = indistinguishable or better). They describe the build at commit `20f2e58` (before this
overhaul) and after it. Every "before" statement below was measured or seen in a frame, not taken from
the README.

How it was measured: the real WebGPU backend in headless Chromium (SwiftShader), 960x540, High preset,
`window.__info` (renderer.info for the whole frame: main view, shadow cascades, the hero car's shadow
map, the reflection probes and every post pass). Baseline frames: chase cam on the main straight in
practice (`?drive`) and the race grid (`?race`).

## Before

| Area | Score | What the frames and the code showed |
|---|---|---|
| Environment art | 2 | Pit building and grandstands are untextured boxes with vertex colours; the crowd is coloured boxes; the start gantry is a black frame; the grandstand roof is a flat green slab. The mountain ring is a 220 x 18 mesh (~140 m facets) in flat grey and white: cardboard cut-outs on the horizon. The asphalt reads as a flat light-grey sheet (the scan brightened 5.2x and desaturated). The verge is flat green with sparse grass clumps. |
| Image clarity | 4 | Soft and hazy: 12% of all light spread by the lens scatter (a milky veil over the frame), a 360-degree shutter with streaks up to 8% of the image height, sensor noise and chromatic aberration on by default, TAA with no sharpening, the canvas capped at 1.5x device pixels and shrunk to 60% by drei's PerformanceMonitor when the frame rate dipped (everything, HUD tags included, went blurry). |
| Performance | 3 | 634 draw calls and 13.0M triangles per frame in practice; **2,177 draw calls and 15.9M triangles** on the race grid. three.js's WebGPU renderer spends tens of microseconds of JS per draw, so the grid alone is tens of ms of CPU per frame. Grass alone: 1.9M triangles. 67 MB of car models downloaded before the first frame, with a 25 s timeout. |
| Lighting | 6 | Strong foundations: photographic HDRI sky with its measured sun, cascaded shadows plus a dedicated map for the car in focus, contact shadows, SSGI, a calibrated camera. Under the veil the picture looked flat. |
| Cars | 6 | Good source models (Ferrari 296 GT3, AMG GT3, Mustang GT3) with dynamic cubemap reflections and a clear coat. No damage, no dirt. |
| Physics | 8 | Genuinely deep: 600 Hz, brush tyre model with thermals and wear, hardpoint suspension, aero map, drivetrain constraints. Costs ~1.6 ms per 60 fps frame for 12 cars, so it is not the bottleneck. |
| Presentation and gameplay | 4 | No replays (a GT7 signature), no photo mode. The chase camera follows the chassis rigidly in height (kerbs jolt the frame) and widens the FOV by 13 degrees at speed (a fisheye at top speed). The Team Principal mode's broadcast director is a real strength. |
| HDR output | 0 | None (GT7's HDR is one of its showpieces). |

## What this overhaul does

See the sections below (filled in as each part lands) and the commit history on `claude/aaa-overhaul`.

### Image pipeline
- **Native output, temporal upscaling.** The canvas is always the display's native resolution (up to 2x device pixels). The scene and everything drawn from its G-buffer render at an internal scale. The TAA is now a temporal upscaler (`taa.ts`): a jittered input grid with 8 phases per output pixel's share of an input pixel (up to 64), every output pixel reconstructed from the 3 x 3 nearest jittered samples with a Blackman-Harris-like kernel of their real distance. The current frame's weight scales with how close its nearest sample is, and the existing motion-based history rejection and YCoCg variance clipping are kept.
- **Dynamic resolution driven by the GPU's own time** (`dynamicRes.ts`): WebGPU timestamp queries where the browser exposes them (so a CPU-bound frame never costs resolution), with hysteresis and 1/32 steps at most twice a second, never below 60%. Each preset also has an internal pixel budget: High renders at most ~1440p and upscales to a 4K display, and renders natively at 1080p.
- **RCAS sharpening** (`sharpen.ts`, AMD FSR 1's robust contrast-adaptive sharpening) on the display-referred image after the tone curve, adjustable in Settings.
- **A clean picture by default.** Lens scatter cut from 12% to 5% with a tighter PSF. 180-degree shutter (was 360) with streaks capped at 5% of the image height. Film grain off (a setting). Half the chromatic aberration and less vignetting. Settings migrate (v5).
- **HDR output** (opt-in, WebGPU): an extended-range half-float canvas on HDR displays. The tone curve is re-targeted to the display's peak (`toneCurveHDR`) so shadows and mid-tones land exactly where SDR puts them and only the shoulder opens up. Peak and paper-white sliders. Tested in `tests/camera.test.ts`. It could not be checked on a real HDR display here.
- **Physical depth of field** for the cinematic cameras only (menu backdrop, showroom, TV broadcast, `lensDof.force` for replays): the circle of confusion of a real lens (focal length from the field of view on a full-frame sensor, an f-number, auto-focus on the car in focus). The driving cameras never get it.
- In-game overlay (Settings → Show frame rate): fps, GPU ms per frame (timestamp queries) and internal → output resolution.
