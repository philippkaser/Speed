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

### Measured (High, 960x540, same views as the baseline)

| | Before (`20f2e58`) | After the first merge | Now |
|---|---|---|---|
| Practice, chase cam: draw calls | 635 | 317 | 239 |
| Practice: triangles per frame | 13.0M | 11.0M | 3.67M |
| Practice: grass triangles | 1.89M | 0.20M | 0.20M (8k of it distant grass cards) |
| Race grid, 12 cars: draw calls | 2,177 | 423 | 399 |
| Race grid: triangles per frame | 15.9M | 13.3M | 5.22M |
| Race grid: main-thread render CPU (perf probe) | 67.8 ms | 54.1 ms | ~30 ms |
| Car model downloads | 69.3 MB | | 63.8 MB, ~10% less again with the server's gzip |

Where the triangles went: 4,386 trackside tyres drawn unculled into every shadow cascade (~5.6M per frame); grass (1.9M); cars at full detail in the shadow maps and probes; the terrain and tree meshes in every cascade and probe face. Where the CPU went: ~2,000 draws, and vegetation instance buffers marked dynamic, which three re-uploaded (4 MB) in every pass that drew them.

### World art
Pit building with a glazed curtain wall, mullions, a control tower, a cantilevered roof and team boards over the garages; a grandstand with a steel-truss cantilever roof and a dense crowd; floodlight towers; a live timing screen; sponsor boards along the barriers; a start gantry with flags; alpine mountains in 12 sectors with real silhouettes, rock and snow; race tarmac with sealant lines, tar snakes and patching; grass in two levels of detail (meshes near, cards far) and denser forests with a forest floor.

### Gameplay
- Drive feel measured with a headless harness (`scripts/feel-probe.ts`, `tests/feel.test.ts`): keyboard and pad pipelines rebuilt, and a steering assist that damps yaw instead of feeding it.
- The chase camera runs on critically damped springs (`tests/drivecam.test.ts`): a steady frame, the car still on screen, +4 degrees of FOV at speed (was +13).
- **Replays:** every car recorded at 30 Hz in compact typed arrays and played back without physics. The TV director picks shots from the recording, plus chase and onboard cameras on any car, a broadcast overlay and transport controls. Watch from the pause menu or the results screen (`tests/replay.test.ts`).
- Results show gaps to the winner, laps down only when really lapped, and the fastest lap, live as the field finishes.

### Performance
Baked car levels of detail built for draw calls, one level-of-detail decision per car, cheap shadow and probe versions, cars left out of cascades their shadow cannot reach, the far cascades drawing the cars' far level, reflection probes without grass and with one matrix update for all faces, skid marks drawn only where laid, car textures on a texel-density budget, and car models loaded in order of need. `scripts/perf-probe.cjs` reports draw calls, triangles and render CPU time per pass.

Later in the performance pass: trackside tyres in culled 150 m cells with a coarse torus for shadows and far cells; the pit lane's roads, paint and team boxes merged (4 draws instead of ~75); car levels of detail simplified to an absolute error; world assets and the session's car models downloading while the renderer starts, and a practice session waiting for one car model instead of three. Fixed on the way: calipers drawn 16 cm off, the steering wheel turning about its bounding box instead of the column, and the hero car's shadow map drawing the far car model.

Later in the world-art pass: terrain and mountains in culled chunks/sectors with one coarse stand-in per reflection-probe face (a probe-only layer); tree meshes cast into the near cascades only (impostors in the far ones and the probes); small props in the near cascades only; the vegetation upload fix above; 27 garages with lit interiors and roller doors, rooms behind the glazed floors, race control at the start line; grandstands with seats, aisles, railings, end-wall panels and a crowd of 64 painted variants with idle motion (motion vectors kept right); lattice start gantry, bridge, braking boards, marshal posts, floodlight masts, TV towers, a big screen, pit-wall stations; mountains carved by simulated drainage with baked ridge shadows; kerbs with faded, chipped paint and shaded rumble ridges; skid marks in braking and traction zones.

### Server
The production server gzips code and models once (cached), revalidates unhashed assets with ETags (304) and sends proper MIME types for .glb, .webp, .jpg and .bin.

## Still behind GT7 (honest list)

- **Vegetation variety:** two tree models; tree lines read as rows of the same tree up close, no bushes or forest edges. Grass cards can look hedge-like at mid distance.
- **Crowd and interiors:** flat cards up close; garage interiors glow rather than being lit.
- **Cars:** no damage, dirt or rain; ~1 GB of uncompressed textures in GPU memory (KTX2/Basis would fix it; not done).
- **Weather and time of day:** the photographic sky fixes mid-afternoon; the dynamic sky has no volumetric clouds and no rain.
- **Audio:** synthesised engines, behind recorded samples.
- **Verification:** everything here was rendered with SwiftShader (software WebGPU) at 960x540; nothing was measured on a real GPU, and HDR output could not be checked on an HDR display. The WebGL2 fallback was rendered once (by the performance pass), not after the world-art pass.

## Second pass (10-13 November, branch `claude/game-graphics-physics-aaa-t13drr`)

The owner's verdict on the build above: graphics still not photo-real, car reflections not clear, car
shadows stutter, the AI cars do not drive a real racing line, and the picture does not look as if a
camera took it (tone mapping, colours, bloom, the way colours clip). This pass went after the causes.
Everything was again rendered with SwiftShader (software WebGPU) at 960x540; nothing here has run on
a real GPU or been seen on a calibrated display.

### What was found and changed

| Complaint | Cause found | Change |
|---|---|---|
| Car shadows stutter | The farthest cascade was not rendered every frame, so car shadows beyond 130 m updated late; the cascade bias was 0.6-2.4 m, so low casters and distant cars cast nothing; only the car in focus had a shadow map locked to it. | The far cascade renders every frame; bias in metres per cascade; every car has its own sun shadow map, locked to the car, in one atlas (`carShadowAtlas.ts`, `?noatlas` for the old path). The cascades keep the static world. |
| Car reflections not clear | A base-coat specular lobe under the clear coat blurred the mirror; the paint's albedo was brighter than any pigment, so the red channel clipped flat. | The clear coat mirrors the probe cube itself, with the sun's own glint; livery texture scaled to pigment albedo; window glass as a dielectric pane. |
| Not a camera's picture | Contrast 1.95 (cameras render at ~1.3-1.55): a hard shadow in the sun landed 4.9 stops under the sunlit ground, and 2-9% of a frame had a channel at zero. A 12% saturation boost and a weakened inset on top: a sunlit red at sRGB 246/19/13, a primary pinned at the gamut's limit. Out-of-gamut colours clipped per channel. 5% lens scatter veiled the shadows by a quarter of their own level. | Contrast 1.5, shoulder 1.2 (a grey card at half of sRGB, a sunlit white panel at ~235), no saturation boost, AgX's full inset (the same red: 234/54/44), out-of-gamut colours brought in towards their own grey, 3% scatter. In-engine: pixels with a channel at zero 2.3 -> 0.9% (chase view), 8.9 -> 4.6% (side), 6.4 -> 3.2% (front three-quarter). |
| Soft picture | The TAA kernel (UE4's `exp(-2.29 d^2)`) converged to a soft image at native resolution; textures were sampled without a LOD bias for the internal scale. | Kernel `exp(-5 d^2)`, current-frame weight 7%, texture LOD bias `log2(renderScale) - 0.5`, anisotropy 16. |
| Cardboard backdrop | Needle peaks in one layer, thin haze. | Two eroded ranges with accordant summits, aerial perspective for ~30 km visibility, weathered buildings. |
| Trees are green blobs | Crowns had no self-shadowing: leaf normals are bent into a sphere at build time and the shadow maps are far too coarse, so front, back, inside and underside were lit alike; the impostors baked the same. | Each crown is a leaf volume: the sun reaching a leaf is cut by the crown between it and the sun, per pixel, in meshes and impostors alike; wider per-tree colour range; shrubs along the forest edges; a ragged grass fringe at the asphalt edge. |
| AI has no real racing line | `computeRacingLine` relaxed towards the midpoint of its neighbours: the shortest path, 1.35 m off the edges, not the fastest. The speed plan ignored what the car can actually do. | A minimum-curvature line over the usable width including the flat kerbs (`src/track/racingLine.ts`), a speed plan calibrated to the car's measured skidpad g(v) with a lateral-jerk limit, path-following steering with curvature feed-forward. Solo AI lap in the GT3: 95.5 s -> 88.6 s, 0.2-0.7 m off the line, largest slide 3.4 degrees. |
| Racing in traffic | Off the ideal line a car had no valid line or speed. The slipstream did nothing for AI cars: on a straight their speed plan (what a car reaches alone) was treated as a cap. Followers were held ~17 m back at speed. | Left and right lane lines with their own speed plans; alongside, attack, one-move defence, rejoin and three-wide rules on lanes; on straights a car runs to its limit, tucks in to a car's length in a tow and pulls out with the run; the corner goes to the inside car with its nose past the other's rear axle at turn-in (a bounded lift for the other, never a stop). |
| Physics (audited with `scripts/physics-audit.ts`) | The suspension carried the sprung mass only (11% too much grip); the limited-slip differential locked twice its setting; rolling resistance was not Coulomb; car-to-car contacts acted off-centre. | Whole-car mass, Coulomb rolling resistance, centred contact with friction, the differential fixed and the GT3 re-balanced, a clutch that launches at the launch revs, slipstream and dirty air from a wake model, a steering assist that works from the tyres' state. |

### Measured

Eight seeded 12-car races of 4 laps (`scripts/race-audit.ts`, seeds 1000-1007):

| | Old line | New line, before lanes | Now |
|---|---|---|---|
| Contacts | 38 | 41 | 1 |
| Spins | 18 | 103 | 2 |
| Off-tracks | 27 | 194 | 3 |
| Stuck cars | 2 | 9 | 0 |
| Hardest nose-to-tail closing speed | 33 km/h | 54 km/h | 0 km/h |
| Overtakes (clean) | | | 108 (108) |

Two cars alone (`tests/lanes.test.ts`): a car about 1 s a lap faster closes in the slipstream and
out-brakes the slower one on the inside, without contact, but when is decided by centimetres. Started
18, 25 and 40 m apart it is through after 138, 291 and 319 s (laps 2 to 4). An earlier version of this
paragraph said "through at 110 s": that was one starting gap; over five gaps that build got by in two
within 400 s, the current one in four.

Rendering cost, practice chase view, High, 960x540 (`scripts/shot.cjs --info`): 216-235 draw calls and
3.5-4.25M triangles depending on what stands in view. The vegetation change added one draw call and up
to 0.9M triangles (shrubs, the grass fringe, more impostors); the shrubs also go into the shadow passes.

Tests: 94 (`bun test`), among them the physics balance ladder, seeded race cleanliness, lane geometry,
the passing scenario, the camera's steadiness and the picture's targets.

### Still behind GT7 after this pass (honest list)

- **The picture** now has a camera's tonal and colour rendering, but the frames are still recognisably
  rendered: what gives them away is in the scene (below), not in the display transform. The sun's
  glare, ghosts and the lamps' glow were not re-judged against camera footage.
- **Trees:** broadleaf crowns are still one saturated green: no light glowing through leaves, no sky
  through gaps; shrubs are scaled-down trees; conifers too dark with orange trunks; trees stand as evenly
  as an orchard.
- **Ground:** the verge is now patchy (clover, worn and dry patches, tussocks to ~40 m), answers to the
  sun's direction and has a ragged soil edge; the asphalt has a rubbered line of two wheel tracks,
  marbles and grid stains. Beyond ~12 m the verge is still a flat textured plane without blade relief;
  the rubber is a smooth band without streaks; paint is too clean where it meets the asphalt.
- **Cars:** wheels, tyres and rims are plain; no contact darkening in the wheel arches; no damage, dirt
  or rain.
- **Effects:** tyre smoke, dust and skid marks were not revisited.
- **AI:** closely matched cars almost never pass each other: with the fastest driver (+0.006 skill,
  ~0.15 s a lap) starting last, it gained 1, 1, 0 and 0 places in four 5-lap races. Side-by-side racing
  is conservative (a lane costs ~4% of pace), there is no late-apex refinement of the line, the
  standing start is cautious, and pit-exit merging was not re-checked after the rejoin rule changed.
- **Player's car:** the Aurel 660 GT oversteers at speed and overheats its rear tyres (its AI lap still
  has 14 s off the track); tyres run 137-152 degrees C in long corners. (The automatic gearbox's
  hunting is fixed: it made 45 shifts in one braking zone from 250 km/h; it now takes each gear once,
  shifts up under power only and holds the gear through the corner. With the lower gears really held,
  engine braking kept the rear tyres at their peak and the car turned 1.7 degrees under straight
  braking, so the rear ABS now holds 0.75 of the peak slip: 0.11 degrees, 250-60 km/h in 112.6 m,
  was 116.5 m.)
- **Verification:** SwiftShader only. No frame time on a real GPU, no check of the WebGL2 fallback after
  the vegetation and shadow-atlas changes, no HDR display.
