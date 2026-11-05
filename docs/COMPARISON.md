# SPEED vs. the reference sims: physics, drive feel, graphics tech

Benchmarks: **Assetto Corsa / ACC** (Kunos), **iRacing**, **Forza Motorsport (2023)**, **Gran Turismo 7**.
For each area the comparison is against the best of the four. Verdicts:
- **Ahead**: SPEED does measurably more.
- **On par**: comparable model structure.
- **Behind**: simplified, or missing real-world data.

The four commercial titles don't publish their models. Statements about them are limited to public information and well-known behaviour, and none of SPEED's numbers have been compared against their telemetry.

## Physics

| Area | Best in class | SPEED | Verdict |
|---|---|---|---|
| Integration rate | AC 333 Hz; others in the ~300–400 Hz class | 600 Hz fixed step with interpolated rendering | Ahead (rate alone doesn't make a better sim) |
| Tyre force model | iRacing NTM / ACC: physically based, multi-zone | Brush contact patch: 3 ribs × 18 bristle elements, parabolic pressure, pressure-dependent rubber friction (emergent load sensitivity), speed-dependent sliding friction, camber via rib load shift and contact-line curvature. Self-aligning moment and pneumatic trail emerge. Carcass relaxation states keep it stable at standstill. | On par in structure. Behind in data: calibrated to plausible compound targets, not to real tyre-rig data (e.g. TTC). |
| Tyre thermals & pressure | iRacing / ACC: multi-layer, multi-zone | Per rib surface and bulk temperatures; shared carcass and inflation gas; ideal-gas hot pressure; rib conduction, convection, road conduction, rolling hysteresis; per-rib wear. Camber produces the real inner/outer temperature spread. | On par (simplified constants) |
| Suspension | AC/ACC/iRacing: 3D hardpoint kinematics, many suspension types | Front-view double wishbone solved from hardpoints: camber, track and instant-centre tables; jacking through the links (migrating roll centre); anti-dive and anti-squat from swing-arm angle; bump steer gradient. Unsprung mass per corner, bilinear dampers, progressive bump stops, ARBs. | Behind (2D linkage, one suspension type) |
| Road contact | Forza: 8 contact points per tyre | 5×3 = 15 samples per tyre, rigid-ring enveloping (smooth-max over the tyre arc). Kerb strikes tilt the contact normal; partial kerb contact shifts load across the ribs. AI uses 3×1. | Ahead in sample count |
| Road surface | iRacing/ACC: laser-scanned, mm accuracy | Procedural micro-geometry: long undulations, mid unevenness, laying joints, braking ripples in braking zones | Behind (no scanned data) |
| Aerodynamics | iRacing/ACC: CFD / wind-tunnel aero maps | Analytic map: ground effect with stall, rake moves the centre of pressure, yaw and roll losses, induced drag, dirty air robs the front | Behind in data, on par in structure |
| Track evolution | iRacing/ACC | Rubber grid (2 m × 1 m) laid by every car's tyres (visible on the road), green track, marbles off-line, track temperature from sun elevation | On par (simplified) |
| Drivetrain | AC/ACC | Engine map, turbo spool, limiter, engine braking, friction clutch, sequential box with cut/blip, clutch-pack LSD with preload and ramps, brake temperature, fade and cold-pad bite. Solved as impulse constraints. No driveline torsional compliance. | Slightly behind |
| Damage & wear | All four | Per-rib tread wear, flat spots from lock-ups (felt once per revolution through the contact model), brake fade and cold-brake bite. No body or mechanical damage. | Behind |
| Validation | Not published | `bun test`: 0–100, top speed, braking, skidpad g, rest stability, crashes, AI laps; tyre and kinematics characterisation (a/3 trail, Mz before Fy peak, load sensitivity, combined slip, camber thrust and temperature spread, roll-centre migration) | Not comparable: SPEED's tests are open; the others publish none |

## Drive feel

| Area | Best in class | SPEED | Verdict |
|---|---|---|---|
| Force feedback | AC / iRacing (native DirectInput, high rate) | Rack torque = Σ(Mz − mechanical trail · Fy) of the front tyres, plus road texture from load changes. Sent to Logitech G29/G923(PS)/G27/G25/DFGT over WebHID at ≤120 Hz. | Behind: browser-limited, experimental, untested on hardware |
| Pad / keyboard | GT7, Forza | Speed-sensitive keyboard steering; slip-angle-targeted steering assist with automatic countersteer; rumble from rear slip, kerbs and the front going light | Unknown: not tested with players |
| Engine sound | GT7 / AC (recorded samples) | Synthesised from the firing order through exhaust waveguides (cross-plane vs flat-plane V8); tyre scrub from the brush sliding fraction | Behind in realism; fully dynamic |
| Sense of speed | All | Speed FOV, road/kerb shake, motion blur at a constant shutter, wind, dense trackside references | On par |

## Graphics tech

| Area | Best in class | SPEED | Verdict |
|---|---|---|---|
| Global illumination | Forza (RTGI in the garage), GT7 | Screen-space GI (SSGI) with temporal filtering on WebGPU; GTAO fallback | Behind: screen-space, because browsers expose no hardware ray tracing |
| Reflections | GT7 / Forza (RT reflections) | SSR (incl. dielectrics), plus a dynamic cube-map probe around the player car for off-screen reflections | Behind |
| Upscaling / AA | GT7 / Forza (temporal reconstruction) | TRAA, TAAU temporal upscaling (70/80% internal on Medium/High), drei PerformanceMonitor dynamic resolution | On par in technique |
| Lighting | GT7 (HDR, physical sky) | Preetham sky with clouds, sun from time of day, CSM shadows, IBL from the sky, aerial perspective, auto exposure (eye adaptation) | Behind (no volumetric clouds/weather) |
| Camera & post-processing | GT7 (physically based camera and exposure; tone mapping in ICtCp that blends per-channel and hue-preserving results; HDR output) | Metered auto exposure; energy-conserving lens scatter with a power-law PSF (mip chain, Karis-filtered so glints cannot flicker); the sun's glare computed from its light: scatter halo, a spectral diffraction star from an FFT of a 7-bladed iris, aperture-shaped ghosts, occlusion measured on the GPU; filmic curve in an AgX-style inset gamut (hue-stable path to white); shot and read sensor noise; dithered sRGB | On par in technique. Behind in display output: SDR only, GT7 also renders HDR |
| Assets | GT7 (500k-poly hand-built cars, scanned tracks) | Procedural SDF car bodies, procedural textures, card-based foliage | Far behind |
| Platform | Consoles / PC installs | Runs in a browser, zero install, WebGPU with WebGL2 fallback | Unique |

## Closing the remaining gaps
1. **Tyre data:** calibrate the brush model against measured tyre-rig curves instead of target figures.
2. **Track data:** import a laser-scanned or LiDAR track mesh as the road surface; the contact model already samples arbitrary heights.
3. **3D suspension kinematics:** extend the solver from a 2D front view to 3D hardpoints (MacPherson and multilink).
4. **Hardware-class GI and reflections:** a WebGPU compute-shader BVH ray tracer for reflections and GI on the car and near field.
5. **Assets:** professionally modelled cars and a scanned venue.
6. **Force feedback:** validate on real wheels; add Fanatec, Thrustmaster and HID++ (G920/G923 Xbox) protocols.
