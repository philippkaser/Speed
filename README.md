# SPEED

A browser racing game built with **React 19, Bun, Vite, React Three Fiber, drei and three.js (WebGPU / TSL)**.
The circuit, buildings and engine sound are generated procedurally at load time. The GT3 cars, the sky, the asphalt and grass surfaces, the trees and the grass are photographed or modelled assets (see Credits), prepared for the browser by the build scripts below.

```bash
bun install
bun run dev      # Vite (http://localhost:5173) + multiplayer server (:3001), Vite proxies /ws
bun run build    # type-check + production bundle in dist/
bun run start    # production: one Bun process serves dist/ and the WebSocket server on :3001
bun test         # physics, AI, multiplayer integration, motion history, drive feel, camera, replay tests
bun run test:gpu # headless smoke test of the real WebGPU backend (needs Playwright + Chromium, dev server running)
```

Measurement tools: `bun scripts/feel-probe.ts` (drive feel: 18 scenarios through the game's own keyboard/pad input and assists, yaw overshoot, slide recovery, lane-change error), `bun scripts/camera-probe.ts` (chase camera frame bob and on-screen car jitter on the real circuit), `node scripts/perf-probe.cjs <url> <query>` (headless Chromium: draw calls, triangles and render CPU per pass; `DETAIL=1` per object). Production (`bun run start`) serves code and models gzipped and revalidates assets with ETags. `docs/REVIEW.md` is the strict review against GT7 with before/after numbers.

Asset builds (only needed when the source art in `new assets/` or `src/car/*/source` changes; the results in `public/` are committed): `bun scripts/build-car-models.ts [id]`, `bun scripts/build-world-assets.ts [sky] [ground] [trees] [grass]`.

Useful URL switches: `?team` (straight into a team race), `?hq` (Team HQ), `?drive` (straight into a practice session), `?race`, `?showroom`, `?car=aurel-gt`, `?gt3=amg-gt3|ferrari-296-gt3|mustang-gt3` (the GT3's bodywork), `?q=low|medium|high|ultra`, `?webgl` (force the WebGL2 backend), `?webgpu` (force WebGPU and never fall back), `?autopilot` (AI drives your car).

Debug switches: `window.__lookSun = true` (turn the camera to the sun, to look at the glare), `window.__camPose = { pos: [x, y, z], look: [x, y, z], fov }` (a fixed camera, for look development and A/B views; `?vegdebug` puts tree positions in `window.__vegDebug.trees` and lets `window.__sunShadow.mode.value` show parts of the sun's shadow: 1 the hero car's map only, 2 the cascades only, 3 the contact shadows only, 4 all but the contact shadows), `?notaa`, `?nocontact`, `window.__wantHdr = true` / `window.__hdrSeq = n` (the next frame / n frames as the camera's exposed linear image, half floats in `window.__hdr` / `window.__hdrs`, for look development), `?aedebug` (the auto exposure's meter reading, target and current exposure in `window.__ae`), `?procsky` (the dynamic sky regardless of the setting), `?notrees`, `?noimpostors`, `?impostorsonly` (impostors at every distance), `?impdebug` (impostor quads: red where coverage fails), `?nograss`, `?showvel` (motion vectors as the blur sees them; spinning wheel parts in blue, calipers in magenta), `?showtiles` (the motion blur's neighbour-max tiles), `?sidecam` / `?sidecam=front|rear|post|heli` (tracking shot alongside the car, a fixed trackside camera placed ahead of the car when `window.__postcam = true` is set, or the broadcast helicopter), `?simonly` (run the game without rendering, for measuring camera and object motion), `?donut` (full lock and full throttle with traction control off, for tyre smoke), `?offscreen` (render into a render target, used by the headless tests).

If the 3D view ever stays black, open Settings → Graphics → Renderer and pick WebGL2, or add `?webgl` to the URL. The game also switches itself: on a fatal WebGPU error (a pipeline or shader that fails to build, a validation error, device loss) it moves to WebGL2, either automatically or from a notice.

## Team Principal mode

You run a two-car team from the pit wall while the race plays out as a live TV broadcast. The race itself is the full simulation: twelve AI-driven cars with real physics, real tyres and real fuel.

**Before the race (Team HQ)**
- name your team and pick its livery
- set up both cars, with the engineer's lap estimate updating live
- plan each car's strategy: start tyre and fuel, then the lap, tyre and fuel of every stop. Stint bars, an estimated race time and warnings ("runs dry on lap 9") update as you plan, and the optimiser offers its best strategies as presets
- a six-round season with points for drivers and teams

**During the race (pit wall)**
- driver instructions: Push, Race or Save. Pushing is faster but costs tyres, fuel and risk; saving does the opposite
- tread, tyre temperature and fuel against laps-to-go, plus the gaps ahead and behind
- **BOX** with your choice of compound and fuel, a "pit now ≈ P7" rejoin prediction, and "stay out" to cancel a call
- time acceleration (1×/2×/4×, key `F`) and camera control (director or follow your car: `0`, `1`, `2`; shot type: `V`)

**What the simulation does**
- **Fuel** is mass on the car, burnt in proportion to engine work.
- **Tyre wear** is scaled to the race length so the compounds have distinct stint lengths. Grip falls steadily as a set wears, then drops off a cliff. Tyres come out of the pits cold.
- **Pit stops** use a real pit lane: the road through the final corner's runoff, the speed limit, team boxes at the garages, crews, and double-stacking when both cars stop together. Each stop has crew variance and the odd slow stop.
- **Drivers** differ in pace, consistency, tyre care and racecraft. They make mistakes, especially pushing on worn tyres, and late-brake for committed passes.
- **Rivals** run their own strategies and react to tyres and fuel.

**The broadcast**
- **Director:** follows battles, overtakes, incidents, pit stops, the lead and your cars, and cuts between long-lens trackside cameras with operator-style pan and zoom, a helicopter, the T-cam onboard, a rear-wing camera, a chase drone, the pit box and the grid and finish cameras.
- **Graphics:** timing tower, start lights, starting grid, lower thirds, battle graphics, a live pit-stop clock, banners for overtakes, undercuts, fastest laps and the last lap, team radio, and commentary (optionally spoken).

**Scripts**
- `bun scripts/sim-team-race.ts [laps]` runs a whole race headlessly.
- `bun scripts/calibrate-race.ts` measures the lap times, wear and fuel numbers the strategy model is built on.

---

## What's inside

### Vehicle dynamics (`src/physics`)
A rigid-body simulation at a fixed **600 Hz**, independent of the frame rate, with interpolated rendering.

- **Tyres** (`tyre.ts`): a physical brush model, not a curve fit.
  - The contact patch length comes from the tyre's vertical deflection, with a parabolic pressure distribution, 3 tread ribs × 18 bristle elements.
  - Rib loads shift with camber, cornering force (carcass roll), inflation (crown vs shoulders) and partial road contact.
  - Rubber friction depends on local contact pressure, so load sensitivity emerges physically. It also depends on sliding speed, rib temperature and wear.
  - Combined slip, the post-peak fall-off, camber thrust and the self-aligning moment / pneumatic trail all emerge from bristle mechanics. The aligning moment peaks well before the lateral force: the wheel goes light at the limit.
  - Carcass relaxation states are integrated implicitly, so the model is stable down to standstill (static friction).
  - Thermals: tread surface and bulk temperature per rib, plus carcass and inflation gas (ideal-gas hot pressure), conduction between ribs, convection, road conduction, rolling hysteresis and per-rib wear. Negative camber produces the real inner/outer temperature spread.
  - Bristle stiffness and rubber friction are calibrated numerically at start-up, so the compound data (peak slip angle and ratio, peak μ, sliding ratio) keep their physical meaning. There are five compounds.
- **Suspension** (`kinematics.ts`):
  - Front-view double wishbones solved from hardpoints, giving camber gain, track change (scrub) and the instant centre against wheel travel.
  - Lateral tyre forces reach the chassis through the links, so jacking forces appear and the roll centre migrates with heave and roll.
  - Anti-dive and anti-squat from the side-view swing arm, and bump steer.
  - Every corner has its own unsprung mass (wheel hop), bilinear bump/rebound dampers, progressive bump stops, droop limits, anti-roll bars, and Ackermann and toe steering geometry.
- **Road contact**: each tyre samples the road at 5×3 points (3×1 for AI) and combines them with a rigid-ring enveloping smooth-max. Kerbs and joints load the tyre progressively and tilt the contact normal (kerb strikes push back and sideways), and one side on a kerb shifts load across the tread ribs. The asphalt carries procedural micro-geometry (long undulations, unevenness, laying joints, braking ripples in braking zones).
- **Drivetrain**:
  - an engine with a torque map, turbo spool with lag, a rev limiter, engine braking and idle control
  - a friction clutch (auto clutch on launch, never stalls)
  - a sequential gearbox with ignition cut and auto-blip
  - a clutch-pack LSD with preload and power/coast ramps
  - brakes with temperature, fade and cold-pad bite; locking a wheel grinds a flat spot into the tyre
  
  The drivetrain is solved as velocity constraints with projected Gauss–Seidel impulses, so clutch lock-up, diff lock and wheel lock all emerge from friction limits.
- **Aero map**: front and rear downforce with ground effect (rising towards the ground, stalling when too low). Rake moves the centre of pressure, yaw and roll spoil the underbody, there's induced and yaw drag, and dirty air robs the front more than the rear. Wing levels are adjustable.
- **Dynamic track**: every tyre lays rubber on a 2 m × 1 m grip map that darkens the road as a session goes on. There's green track off-line, marbles near the edges, and track temperature that follows the sun.
- **Steering and force feedback**: the rack torque is the sum of the front tyres' self-aligning moments and mechanical trail, plus road texture. It drives force feedback for Logitech G29/G923 (PlayStation version)/G27/G25/DFGT wheels over WebHID (experimental) and gamepad rumble.
- **Assists**: ABS (per-wheel slip control; the rear wheels are held at 0.75 of the tyre's peak slip so the rear axle keeps its side force under braking), traction control (5 levels), a steering assist for keyboard and pad (slip-angle targeted, with auto counter-steer), and an automatic gearbox that shifts like a driver with paddles (up under power only, each gear once through a braking zone, the gear taken on the brakes held through the corner). All of these can be switched off.
- **Collisions**: hull probes against barriers and the ground (sparks when bottoming), and car-to-car SAT boxes with impulses.

Measured in `bun test` (flat ground, warm tyres):

| | Vanta R-GT3 (slicks) | Aurel 660 GT (sports tyres) |
|---|---|---|
| 0–100 km/h | 3.6 s | 4.2 s |
| top speed | 281 km/h (gearing) | 323 km/h (drag) |
| 200–0 km/h | 75 m, 2.4 g peak | 112 m |
| skidpad (R 60 m) | 1.64 g | 1.14 g |

`tests/tyre.test.ts` checks the tyre and kinematics against known physical behaviour: pneumatic trail = a/3 at small slip, aligning-moment peak before the force peak, falling μ and rising peak slip with load, the combined-slip friction circle, low camber stiffness, inner-shoulder heating from negative camber, negative camber gain and a migrating roll centre. `docs/COMPARISON.md` compares SPEED with AC/ACC, iRacing, Forza Motorsport and GT7, area by area.

### Circuit (`src/track`)
*Autodromo Valle Alta* is an original 4.6 km layout. It's a closed centripetal Catmull-Rom spline with elevation, banking and variable width. From that spline the build automatically generates:
- kerbs on apexes and exits, with rumble ridges
- asphalt or gravel runoff chosen by corner speed
- barriers kept clear of other parts of the track
- a minimum-curvature racing line and a quasi-steady-state speed profile, which are used by the AI, the driving line and the brake boards

`track.ts` implements the physics ground query (height, normal, surface type, track coordinates and barriers) in O(1) using spatial hints. `bun scripts/plot-track.ts out.svg` renders the layout.

### Rendering (`src/render`)
`WebGPURenderer` inside R3F, with all materials written in TSL so the same code runs on both backends. The game uses the WebGL2 backend in two cases:
- WebGPU is unavailable.
- WebGPU reports a fatal error. The switch is automatic while loading or in the menus; while driving, a notice offers it.

The G-buffer fits WebGPU's default 32-byte colour-attachment budget, and the renderer still requests the adapter's full limit.

`scripts/gpu-smoke.cjs` drives the real WebGPU backend in headless Chromium. It renders offscreen through the `?offscreen` test mode and reads the frames back. It fails on any renderer error or a black frame.

- **Lighting**:
  - **photographic sky** (default, `photoSky.ts`): Poly Haven's *Kloofendal 48d Partly Cloudy* HDRI.
    - `bun scripts/build-world-assets.ts sky` stores it as an 8-bit colour image plus an 8-bit log2 gain map (radiance = colour × 2^gain, sun included), ~600 KB instead of 75 MB, decoded in the shader.
    - The sun's direction, colour and irradiance are measured from the disc in the photograph. The directional light carries the sun; the sky is scaled to keep the photograph's sun-to-sky ratio. The environment map (PMREM) is captured from the sky without its sun disc, over a lit ground.
    - The sky dome rides with the camera (no parallax, no motion from translation in the motion blur). Distant terrain fades into the sky's own horizon behind it.
    - The photograph fixes the sun at 48° (mid-afternoon); Settings → Graphics → Sky → *Dynamic* switches to the procedural sky.
  - **dynamic sky**: physical sky with clouds (`SkyMesh`), sun direction and colour from the time of day
  - **the sun's shadow** (`sunShadow.ts`), three parts multiplied together. (Until this version the game had no sun shadows at all: the reflection probes paused shadow updates while they rendered, and the cascades, which three's CSM clones from the sun's shadow on the first material build, were created during a probe render, cloned paused, and never rendered. The probes now pause only the cascades that exist and resume them all, and the cascades are kept rendering every frame.)
    - cascaded shadow maps with their breaks in metres where the subjects are: the first ends at 12 m (the car in the chase and cockpit views at ~1 cm per texel on High), then 38 and 130 m, out to 400 m (650 m on Ultra), blended across the borders. three's "practical" split put the first break at ~50 m (3–5 cm texels) and the cars lost their small self-shadows
    - a dedicated map for the car in focus (the one with the high-resolution reflection probe): orthographic, fitted to the car's bounding sphere, 2048² (a few mm per texel) and snapped to its texel grid so it does not shimmer. The car shadows itself in detail (mirrors, the wing on the deck, wheels in their arches, the roll cage in the cockpit) and casts a crisp contact shadow, at any distance, also through a TV camera's long lens. The car is drawn on its own layer, so the cascades leave it out and its coarse cascade shadow cannot blur the fine one
    - *contact shadows* (`contactShadows.ts`, Medium and up; Settings → Contact shadows): what the shadow maps are too coarse for (blades of grass on the ground, the base of a trunk, the lip of a kerb, a tyre on the road, small parts of the cars), at any distance. After the scene pass a full-screen pass marches from every pixel towards the sun through the depth buffer (12/16/20 steps, half resolution, full on Ultra; the ray and the assumed thickness grow with distance; jittered per frame, so the TAA smooths the steps). Only casters that move with the receiver count: the mask is read next frame reprojected with the receiver's motion, which is wrong for a shadow cast by something moving across it (a car over the road jittered); the cars' contact shadow comes from their own map. The materials read the mask in the next frame as part of the sun's shadow, reprojected with the motion vectors and only where the distance matches, so it dims only the sun's direct light, never the sky's or bounced light, and no surface takes another's shadow. No extra geometry pass. The mask has a fixed size: the scene's materials hold it, and resizing it under them destroyed the texture they were bound to
    - beyond the cascades, the distant forests' shadows on the ground: every tree's crown projected along the sun onto the ground as a soft ellipse (offset h / tan(elevation) away from the sun, stretched 1 / sin(elevation) along its azimuth), splatted once into a 2048² ground-level map over the circuit. No per-frame cost; recomputed when the sun moves. Only the far receivers (terrain, tree impostors) sample it: every texture in the shared shadow term is bound in every lit material, and WebGPU allows 16 per shader stage (the renderer asks the adapter for its full budget, but SwiftShader and many devices stop at 16). Material-specific factors (this one, the grass canopy) are applied once in the sun's shadow node; a material's receivedShadowNode would be applied by every cascade and the hero map
  - image-based lighting from a PMREM of the sky
  - height-attenuated aerial perspective
- **Post-processing** (`PostFX.tsx`), in order:
  - MRT scene pass (colour, normals, albedo, metal/rough, velocity)
  - **SSGI** for screen-space indirect light and AO (WebGPU) or GTAO (fallback)
  - **SSR** (optional, off by default): screen-space reflections on top of the cars' cubemaps
  - **temporal anti-aliasing** (`taa.ts`, Medium and up; SMAA without it, FXAA on Low): each frame is rendered with a Halton sub-pixel offset and accumulated with the reprojected history, so edges, the catch fence's wires, grass blades, leaves and glints, all smaller than a pixel, resolve cleanly instead of crawling, and the screen-space GI's noise converges (it runs with three's temporal presets, fewer samples). The resolve:
    - motion of the closest surface in 3 × 3; history read with a 5-tap Catmull-Rom filter (bilinear history reads blur a little more every frame)
    - *rejection by motion, not by depth*: last frame's velocity target is kept, and the history is trusted only where the surface there last frame moved like the surface here now. In a tracking shot the road just uncovered behind a car moves fast while the car that covered it did not, so the road takes none of the car's history at any distance. (three's TAA, removed earlier, told surfaces apart by depth with fixed thresholds, which at 100 m cannot separate a car from the road behind it: the cars smeared in helicopter and long-lens shots.) Where the test fails, the current sample is tent-filtered over the neighbours that move like it (never road into a car's outline) and only a quarter of the clipped history stays
    - variance clipping in YCoCg towards the current neighbourhood, blending in a tonemapped space (a glint cannot dominate), 10% of the current frame where the history is trusted and still, more as the pixel moves faster; history dropped on camera cuts, NaN-safe
  - **per-object motion blur as a camera shutter** (`motionBlur.ts`, `motionHistory.ts`), a tile-based reconstruction filter (McGuire 2012, with Guertin 2014 and Jimenez 2014 refinements):
    - *shutter*: the setting is a shutter angle, the share of each frame's own interval the shutter is open. The default is 360°: every streak ends where the next frame's begins, so motion is continuous from frame to frame at any frame rate. Shorter shutters (180° is the film look) leave gaps that the eye sees as separate copies in fast pans, the strobing that makes helicopter shots look like a row of doppelgängers
    - *camera*: the blur uses the camera's exact path, so whatever it follows (the car in a chase or helicopter shot) or is mounted on (the cockpit) stays sharp; a smoothed path lags behind every change of speed or direction and smeared exactly those. Deliberate shake (kerbs, mount vibration) is taken out exactly: the rigs report their pose before shaking (`markCameraPath`), and the blur uses last frame's path with this frame's shake. The chase camera's g-force offsets are low-passed; they used to make it twitch by centimetres every frame, which smeared the car
    - *prepare*: each pixel's streak is resolved once (exposure, stabilisation, wheel hubs, clamping to the longest streak) for the passes that follow
    - *tile max / neighbour max*: the longest motion that can reach every tile, so a fast object's blur spills over the static pixels around it instead of stopping at its own outline
    - *screen edges*: beyond the frame there is nothing to blur with; taps that fall off the image are dropped and the streak is renormalised over the taps on it (clamped taps repeated the border pixel and smeared bands along the edges)
    - *gather*: taps along the dominant motion and the pixel's own, weighted by which surface is in front and whose streak covers the pixel. A sharp car in front of a streaking background never smears into it; the hidden background is continued from the mirrored tap, so streaks run right up to a crisp outline, like a panning shot. Box-shaped weights give the uniform streak of a real shutter, not a soft smudge. Where everything moves as one (a helicopter pan, the road under a chase camera) the streak is a dense box filter (a tap every ~1.25 px, up to 64), so it comes out smooth instead of as stepped copies; still tiles exit at once
    - *cars meet the ground*: the velocity target tags cars' surfaces (a fraction on the wheel-slot channel). Near equal depth a car is always in front of the ground: the road just below a car's lip is a few cm nearer than the lip, and by depth alone the fast road streaked over the car (asphalt in the car) while the car was gathered into the road's streak (its lip on the asphalt); a car's edge pixel never adopts the ground's motion either
    - *order*: with TAA the blur comes first and TAA smooths its result (the velocity target is drawn with TAA's sub-pixel jitter, so the blur's boundaries move by up to half a pixel every frame, and its sampling noise changes every frame); without TAA, SMAA works on the sharp image and the blur follows
    - *wheels*: every spinning wheel near the camera gets a slot, and its pixels follow their real screw motion. Each tap rotates the pixel's view-space position about the axle by its share of the angle swept during the exposure, adds the hub's motion and projects back. Spokes blur into a disc, the tyre keeps its outline, calipers stay sharp behind the rim, and seen side-on from a fixed camera the contact patch stays still while the top of the tyre streaks
    - *motion vectors*: every mesh's and the camera's previous matrix advances exactly once per frame, including objects that were hidden (LOD switches), so nothing streaks for a frame when it reappears. Spinning parts without a slot report their hub's motion, not the chord of their rotation. Wind-swayed foliage moves its previous position with last frame's clock. Transparent surfaces (glass, decals, the ghost car) keep the motion of what's behind them, so the world through a windscreen blurs with the world. The velocity target also carries the wheel slot and the depth of the surface that owns the motion
    - the frame of a camera cut is not blurred (nothing in the new shot has a previous frame to have moved from; keeping only the objects' motion smeared a car the camera follows into copies). The catch fence's posts and top rail are solid (alpha tested) so they streak with the barriers, while its wire mesh is a blended veil that keeps the motion of what's behind it
  - **the camera's exposure**: a base exposure calibrated like a camera's meter on a sunny track (asphalt and grass near middle grey, sunlit cloud tops in the shoulder, the sun far beyond white), following the sun's height with the dynamic sky, plus an *exposure compensation* setting (±1.5 stops)
  - **auto exposure** (`autoExposure.ts`, Medium and up), metering like a real camera: the exposed frame is reduced to 64 × 36 cells (4 × 4 points each) of log luminance with a centre-weighted pattern that favours the subject (the lower middle of the frame: the car and the road) over the sky, read back asynchronously every few frames. The darkest 30% and the brightest 10% of the weighted histogram (deep shade; the sun, its glints and white clouds) are left out and the rest averaged in log space. The exposure follows 80% of that average's distance from the calibrated key, within ±2 stops, like an eye: the cockpit and the shade open up, looking into the sun stops down to a deep blue sky. It stops down faster than it opens up, and a camera cut starts at its target
  - **the lens** (`lens.ts`, `aperture.ts`): what a real lens adds between the scene and the sensor:
    - *lens scatter* without a threshold, energy conserving: 3% of all light spreads over the lens's long-tailed point-spread function (a power law in radius plus a diffusion glow at medium radii), so only what is far brighter than its surroundings shows a halo. The bright sky glows over the horizon, the roof line and the A-pillars; looking into the sun veils the frame. It is a weighted sum of the levels of a mip chain (13-tap downsample, tent upsample, Jimenez 2014); each level doubles the PSF's width and the weights are set in image heights, so the lens looks the same at every resolution
    - *temporal stability*: the chain's first downsample takes a partial Karis average and clamps each tap, so a glint one pixel wide (the sun in the clear coat, a wheel nut) that appears and disappears between frames can add no more to the halo than an ordinary bright pixel. That removes the one-frame fireflies of the old bloom and its bright-pass starburst
    - *the sun's glare* is computed from the sun's light (the directional light's strength at the camera's exposure), so it is exactly stable however the sun's few pixels alias, and it continues when the sun is just outside the frame: its share of the lens scatter with the same PSF; the iris's diffraction star; and (High, Ultra) ghosts, images of the iris strung along the line from the sun through the centre, each tinted by its coating, with a little dispersion at the rim and its energy spread over its area. How much of the sun is visible is measured on the GPU (32 depth samples across its disc, smoothed over two frames) and read by the glare in the same frame
    - *diffraction star* (`aperture.ts`): the Fraunhofer pattern of a 7-bladed iris with slightly irregular blade edges, computed once in a worker (1024² FFT of the aperture, summed over 16 wavelengths with the CIE 1931 colour matching functions, so the spikes carry faint spectral fringes). The radially symmetric part is left to the lens scatter; the 14 spikes are kept, and widened by the sun's disc on screen through the texture's mip chain (a telephoto shot of the sun has broad spikes, a wide shot fine ones)
    - *lateral chromatic aberration* growing with the square of the distance from the centre
    - *natural vignetting*: the cos^4 law of the off-axis angle from the lens's real field of view (a TV camera's long lens barely darkens its corners, the wide chase camera does), 40% of it left uncorrected
  - **the sensor** (`sensor.ts`): photon shot noise (variance proportional to the signal) and a little read noise, new every frame and mostly in luminance: a few percent in the mid-tones, more in the shadows, none in the highlights
  - **the picture** (`sensor.ts`): a filmic tone curve applied per channel inside an inset gamut, the approach of Troy Sobotka's AgX with our own curve. Per-channel curves alone skew bright saturated colours towards the secondaries (red to orange to yellow, blue to purple); luminance-based ones go pastel abruptly or clip. In the inset gamut a bright colour keeps its hue and desaturates smoothly, and only the brightest light reaches white; the outset afterwards restores the saturation below the highlights. The curve is a log-logistic sigmoid anchored so sunlit asphalt sits at ~37% sRGB, with the contrast of a camera's standard rendering (1.5, between a still camera's ~1.3-1.4 and a cinema camera's display LUT at ~1.55) and no saturation boost on top: a grey card lands at half of the sRGB range, a hard shadow in the sun 3.75 stops under the sunlit ground (deep, with its detail), a sunlit white panel at sRGB ~235, sunlit clouds just under white with their shading, the sky near the sun and the sun itself rolling smoothly into white with no clip edge. What is still outside the display's gamut after the outset is brought in towards its own grey (hue and luminance kept) instead of clipping each channel. Before November 2026 the contrast was 1.95 with a 12% saturation boost and a weaker inset: shadows went to black and sunlit colours sat at the gamut's edge (a sunlit red at sRGB 246/19/13), which read as a game, not a camera
  - **encoding**: the sRGB curve, then triangular dither of one code value, so sky gradients and the glare's halo show no 8-bit banding
  - `tests/camera.test.ts` checks the tone curve (anchored, monotonic, no kink), the colour rendering (greys neutral, a bright red stays red on its way to white), the PSF (energy and shape independent of resolution) and the star (spikes only, point symmetric)

  - **resolution** (`dynamicRes.ts`, `taa.ts`): the canvas is always the display's native resolution (up to 2x device pixels); the scene and every pass drawn from its G-buffer render at an internal scale, and the TAA is a **temporal upscaler**: the jitter is on the input grid (8 phases per output pixel's share of an input pixel, up to 64), and every output pixel is reconstructed from the 3 x 3 nearest jittered samples with a Blackman-Harris-like kernel of their real distance, the current frame weighted by how close its nearest sample is. A per-preset pixel budget caps the internal resolution (Medium 2.1, High 3.7, Ultra 8.3 megapixels: High renders natively at 1080p and ~1440p for a 4K display). **Dynamic resolution** holds the target frame rate (Settings) by the GPU's own time per frame from WebGPU timestamp queries (the frame interval where there are none), in 1/32 steps with hysteresis, never below 60%
  - **sharpening** (`sharpen.ts`): AMD FSR 1's RCAS on the display-referred picture after the tone curve (Settings → Sharpening)
  - **depth of field** (`dof.ts`) for the cinematic cameras only (the menu's backdrop, the showroom, the TV broadcast; `lensDof.force` for others): a physical lens, the circle of confusion from the focal length (the field of view on the sensor), the f-number and the focus on the car in focus, gathered in one pass (scatter-as-gather; a tap behind the pixel spreads no further than the pixel's own blur, so outlines in focus stay crisp). `?nodof` turns it off; `window.__lensDof` exposes the lens
  - **HDR output** (Settings → HDR output, opt-in, WebGPU on an HDR display): an extended-range half-float canvas; the tone curve is re-targeted to the display's peak over its paper white (`toneCurveHDR`), so shadows and mid-tones sit where the SDR picture has them and only the highlights open up
  - by default the picture is clean: 3% lens scatter, a 180-degree shutter with streaks capped at 5% of the image height, film grain off (Settings → Film grain)

  Quality presets are Low, Medium, High and Ultra. Settings → Show frame rate shows the GPU's time per frame and the internal → output resolution.
- **Car reflections** (`Reflections.tsx`): dynamic cubemaps rendered around the cars, as the best-looking racing games do it (Gran Turismo gives every car one detailed shared cubemap, Forza Horizon renders dynamic car cubemaps and adds ray-traced detail, Assetto Corsa renders a few of a car's six cube faces per frame).
  - The car in focus (the player in the chase and cockpit views, the framed car in TV shots: the biggest on screen) gets a high-resolution probe: 256, 512 or 1024 px per face (Medium, High, Ultra), 1–3 faces rendered per frame, then GGX-prefiltered in place, so the clear coat reflects like a mirror and rougher surfaces blur correctly.
  - The next most visible cars get probes from a small pool (128–256 px, refreshed in turn); every other car shares the hero's probe. Other cars are in the probes, so the cars reflect each other.
  - Cheap probes: no shadow-map re-render for the probe cameras (three renders shadows once per camera per frame: every probe update used to cost 24 shadow passes), cars at their simplest level of detail, grass and small props left out, the sky dome following the probe camera.
  - The models' paint is a dielectric base coat under a glossy, mirror-smooth clear coat (roughness 0.03; the Ferrari's livery came as metallic with almost no clear coat). Physically a clear coat reflects 4% head-on, which over a bright base in full sun all but hides the mirrored sky and horizon; like real multi-layer finishes and every racing game, it reflects ~2.2x that head-on and the exact Fresnel towards grazing angles. The base coat's flake normal map is turned down (at 1K it became grain).
  - Glass is a smooth dielectric (it came metallic), its reflection compensated for the alpha blending (real glass reflects the same however clear it is). It has no diffuse colour: the sources' tints were meant for metallic glass and on a dielectric became a sunlit layer (the Ferrari's windows glowed green), so untextured window glass is black and at most 30% opaque (GT3 windows are near-clear polycarbonate). Exterior carbon is clear-coated. Every car has its own materials, so each carries its own probe.
  - Screen-space AO and GI on the cars only with TAA: without it the passes' noise sat on the clear coat's reflections as grain (a per-object weight in the G-buffer's normal target). With TAA the noise converges and the cars get their contact shading (wheel arches, under the wing, the diffuser, panel gaps), the reflections in those cavities occluded too, as they are in reality.
- **GT3 cars** (`src/car/gltfCars.ts`): detailed Ferrari 296 GT3, Mercedes-AMG GT3 and Ford Mustang GT3 models.
  - `bun scripts/build-car-models.ts` turns the source GLBs in `src/car/*/source` and `new assets/` into `public/models/*.glb` (18, 16 and 35 MB from 68, 55 and 122 MB). A source may be a zipped GLB (the Mustang's is 122 MB unpacked, over GitHub's 100 MB file limit). It normalises each model to the physics wheelbase, splits the wheels into four pivoted corners, separates the steering wheel (its axis is found from the rim geometry), merges draw calls by material, builds two simplified levels of detail, converts textures to WebP (colour maps at 1K, the livery up to 4K, and normal, roughness, metalness and clear-coat maps at the source's full resolution: near-lossless, or lossy where the data is noise-like, such as metallic flake) and compresses the geometry with meshopt.
  - **Team liveries:** each car recolours the model's livery texture in the shader, mapping the navy base to the team colour and the red accents to the team accent, so logos and decals stay intact. The Mustang's lighter blue stripes become a lighter shade of the team colour.
  - **Level of detail** is chosen by on-screen size: the TV cameras' long lenses get the full model even from far away.
  - Wheels spin, steer and follow the suspension, discs glow with brake temperature, brake lights respond to the pedal, and there is a driver in team colours.
  - The other cars keep the procedural bodies below.
- **Procedural cars** (`src/car/carModel.ts`): bodies are sculpted as **signed distance fields**, meshed with Surface Nets and snapped back onto the exact surface:
  - lofted tub and greenhouse, smooth-blended fenders, cut wheel arches, intakes, vents and a Kamm tail
  - triangles are classified into paint, glass, carbon, lights, grille and wheel wells
  - clear-coat metallic-flake paint with a procedural livery and race numbers
  - lathe tyres with sidewall lettering, multi-spoke rims and centre locks
  - brake discs that glow with the simulated brake temperature
  - airfoil wing, cockpit with a driver and a steering wheel that turns
- **World**:
  - **photo-scanned surfaces** (Poly Haven): race asphalt, older pit lane asphalt (runoff and pit lane), mown grass and leafy forest floor. `bun scripts/build-world-assets.ts ground` packs each set into a colour map (ambient occlusion baked in, 1024 px) and a data map (normal x/y + roughness at the scan's full 2048 px: the fine relief and the play of roughness in the light are what make the surfaces read as real up close, more than the colour's resolution). In the shaders:
    - two decorrelated samples per surface (the second rotated, scaled and shifted), blended by slow noise with a variance-preserving blend, so the 2–3 m scans never visibly repeat
    - the near-black fresh asphalt scan is weathered to a mid grey; the dry grass scan is shifted to summer green
    - rubber, dust, paint lines and macro variation stay procedural on top
  - procedural gravel and concrete
  - the racing line is rubbered into the road shader
  - terrain blended into hills and an alpine mountain ring
  - armco, painted concrete walls, tyre walls, catch fences
  - grandstands with crowds, pit building, start gantry with working lights, bridge, billboards, 300/200/100 m boards, marshal posts
  - **vegetation** (`Vegetation.tsx`), every kind of it a single draw call however many plants there are:
    - two tree models (a pine and a broadleaf tree, Sketchfab, CC BY 4.0), baked by `bun scripts/build-world-assets.ts trees` into one mesh with one material each: trunk and leaf textures packed into one atlas, leaf cards flattened to quads, branches simplified (pine 2.2k, broadleaf 6.1k triangles), canopy normals bent outwards for soft, volumetric shading
    - each model is one instanced draw for every tree within ~220 m; beyond that every tree of every model is an **impostor**, one quad per tree in one more draw, baked at load time from the real meshes (16 directions, albedo and canopy normals), read back into textures with a coverage-preserving mip chain (plain mipmaps average an alpha-tested tree's coverage away until it vanishes in the distance), and lit like the meshes. Meshes and impostors cross-fade with a dither
    - **3D grass** on the verges (Poly Haven *grass_medium_01*, its alpha mask derived from the texture's black background): clumps simplified and arranged into one 1.4 m patch mesh (1.8k triangles), instanced around the camera in one draw. The blades take their colour from the ground they stand on, so they fade into the ground texture. A dense canopy shades itself: towards the roots the blades see less of the sky (ambient occlusion, 32% at the ground) and less of the sun (28% at the ground, on top of the shadow maps), from their height in the patch
    - instances live in a grid of cells; each frame the visible cells are packed into the instance buffer nearest first (only a change uploads anything), each shadow cascade draws the prefix of instances its range needs, and distances are judged by size on screen (the TV cameras' long lenses get the meshes further out)
    - wind sway and leaf flutter; the previous position moves with last frame's clock, so the motion blur sees the wind's motion only
- **Effects**: tyre smoke, dust on grass and gravel, skid marks and sparks.
  - Smoke comes from the contact patch in proportion to friction power above the vaporisation onset, and more from a hot tread.
  - Each puff rides the car's wake, rises with buoyancy while hot, wanders with turbulence, rolls along the road, and grows by turbulent diffusion while its optical depth falls as 1/r² (mass conserved).
  - Particles render in their own pass, composited over the lit image and sorted back to front. They fade softly against the scene depth instead of cutting into the road. The smoke is shaded as a scattering medium: sun lighting with self-shadowing along the light path, sky light from the environment, and Henyey-Greenstein forward scattering (thin smoke glows against the sun).
- **Replays** (`src/game/replay.ts`, `src/ui/hud/Replay.tsx`): every car recorded at 30 Hz in compact typed arrays (practice keeps the last 15 minutes, races 45) and played back without physics; "Watch replay" in the pause menu and on the results. The TV director (`broadcastCam.ts`) picks battles, overtakes, slides and the finish from the recording; chase and onboard cameras on any car; play/pause, ±5 s, scrub, 0.25x-4x; keys Space, arrows, [ ] for the car, C for the camera, Esc back.
- **Gameplay aids**: a GT-style driving line (red braking zones, yellow at the limit, green under acceleration) from your car's own speed profile, a time-trial ghost of your best lap, and opponent name tags with positions (drei `<Html>`).
- **Cameras**:
  - chase and near chase, with a slip-aware yaw lag, speed-dependent FOV and road/kerb shake
  - cockpit with g-force head motion, plus hood and bumper
  - TV, helicopter and track-side cameras for the attract mode
  - an orbit showroom

### Audio (`src/audio`)
Engines are synthesised in an **AudioWorklet**. Per-cylinder exhaust pulses follow the real firing order, so a cross-plane V8 burbles and a flat-plane V8 screams. The pulses feed per-bank waveguide exhaust resonators, plus intake roar, mechanical harmonics, overrun crackle and turbo whine. Around that:
- tyre squeal driven by slip
- wind, road and kerb rumble, gravel
- straight-cut gearbox whine, shift clunks, impacts
- HRTF-positioned opponent engines with Doppler
- UI sounds

### Input
- Keyboard: speed-sensitive steering rate.
- Gamepads (standard mapping): triggers, stick linearity and deadzone, rumble driven by tyre slip and kerbs.
- Steering wheels: detected by id, with axis binding by moving the control in Settings.

### UI
A GT-inspired interface in clean glass panels over a live 3D attract mode:
- title, home, race and time-trial setup
- garage with paint and a full tuning sheet that feeds the physics live (ride frequencies, aero balance and downforce shown as you tune)
- settings: graphics, assists, controls with wheel binding, audio, gameplay
- online lobby, pause, results
- HUD:
  - arc tachometer with shift lights, gear and speed, pedal traces, TC/ABS lamps
  - lap and sector timing with a live delta to your best
  - standings and minimap
  - tyre temperatures against the compound window, g-meter
  - start lights and track-limit warnings

### Multiplayer (`server/index.ts`, `src/net`)
One Bun process provides WebSocket lobbies (quick match or 5-letter room codes) and runs the authoritative race flow: ready, a countdown on the server clock, a race, results. Each client:
- simulates its own car at full fidelity and streams state at 30 Hz
- shows remote cars 110 ms in the past, with Hermite position and slerp rotation interpolation and short extrapolation on packet loss
- treats remote cars as kinematic bodies in collisions and the slipstream

The clock offset comes from the lowest-RTT ping samples. Positions are derived from race distance.

## Controls

| | Keyboard | Pad |
|---|---|---|
| Throttle / brake | W S / ↑ ↓ | RT / LT |
| Steer | A D / ← → | left stick |
| Shift up / down | E, Shift / Q, Ctrl | A, RB / X, LB |
| Handbrake | Space | B |
| Camera | C | Y |
| Look back / left / right | B / Z / X | View |
| Reset to track | R | D-pad down |
| Driving line | L | |
| Brake balance rear / forward | [ / ] | |
| Traction control level | T | |
| Telemetry overlay | I | |
| HUD | H | D-pad up |
| Pause | Esc / P | Start |

## Notes
- WebGPU gives the full pipeline (SSGI). On the WebGL2 fallback, SSGI is replaced by GTAO and everything else stays.
- `?noprobe` turns the car reflection probes off (the cars reflect the sky only); `?chromecars` (mirror-chrome cars) and `?blackpaint` (gloss black under the same clear coat) show what the probes and the clear coat reflect; `?refldebug` exposes the probes as `window.__refl`.
- Browsers expose no force feedback for steering wheels, so wheels get no FFB. Gamepads get rumble.
- Set `VITE_SPEED_SERVER=wss://host/ws` at build time to point the client at a separately hosted server.

## Credits

Car models by **vecarz** ([Sketchfab](https://sketchfab.com/heynic)):
- [Ferrari 296 GT3 VERSTAPPEN | www.vecarz.com](https://sketchfab.com/3d-models/ferrari-296-gt3-verstappen-wwwvecarzcom-cd9e1436a1a2471ea4106490f2ec8955), licensed [CC BY-NC 4.0](http://creativecommons.org/licenses/by-nc/4.0/). Non-commercial use only.
- [Mercedes AMG GT3 Evo 2020 | www.vecarz.com](https://sketchfab.com/3d-models/mercedes-amg-gt3-evo-2020-wwwvecarzcom-39e77243109f4e5cb7134b6f31c8f619), licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/).

- [Ford Mustang® GT3 2024 | www.vecarz.com](https://sketchfab.com/3d-models/ford-mustang-gt3-2024-wwwvecarzcom-edc0d377ada74c8d8dcf12f719f81c65), licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/).

All three are modified for the game (normalised, re-pivoted, simplified, recompressed, recoloured per team).

Trees, both licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) and modified for the game (merged, simplified, re-textured into one atlas):
- [Pine tree](https://sketchfab.com/3d-models/pine-tree-e52769d653cd4e52a4acff3041961e65) by Andriy Shekh
- [Realistic Tree](https://sketchfab.com/3d-models/realistic-tree-d989c0f801d847b9a74992ec4ddcfdfc) by Daniel

From [Poly Haven](https://polyhaven.com) (CC0): the *Kloofendal 48d Partly Cloudy (Pure Sky)* HDRI, the *asphalt_track*, *asphalt_pit_lane*, *grass_ground* and *leafy_grass* textures and the *grass_medium_01* model.

The credits also appear in Settings → Gameplay.
