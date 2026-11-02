# SPEED

A browser racing game built with **React 19, Bun, Vite, React Three Fiber, drei and three.js (WebGPU / TSL)**.
Everything — car bodies, circuit, textures, scenery, engine sound — is generated procedurally at load time. There are no downloaded assets.

```bash
bun install
bun run dev      # Vite (http://localhost:5173) + multiplayer server (:3001), Vite proxies /ws
bun run build    # type-check + production bundle in dist/
bun run start    # production: one Bun process serves dist/ and the WebSocket server on :3001
bun test         # physics, AI and multiplayer integration tests
bun run test:gpu # headless smoke test of the real WebGPU backend (needs Playwright + Chromium, dev server running)
```

Useful URL switches: `?team` (straight into a team race), `?hq` (Team HQ), `?drive` (straight into a practice session), `?race`, `?showroom`, `?car=aurel-gt`, `?q=low|medium|high|ultra`, `?webgl` (force the WebGL2 backend), `?webgpu` (force WebGPU and never fall back), `?autopilot` (AI drives your car).

Debug switches: `?showvel` (motion vectors), `?donut` (full lock and full throttle with traction control off, for tyre smoke), `?offscreen` (render into a render target, used by the headless tests).

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
- **Assists**: ABS (per-wheel slip control), traction control (5 levels), a steering assist for keyboard and pad (slip-angle targeted, with auto counter-steer), and an automatic gearbox. All of these can be switched off.
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
  - physical sky with clouds (`SkyMesh`)
  - sun direction and colour from the time of day
  - cascaded shadow maps
  - image-based lighting from a PMREM of the sky
  - height-attenuated aerial perspective that brightens towards the sun
- **Post-processing** (`PostFX.tsx`), in order:
  - MRT scene pass (colour, normals, albedo, metal/rough, velocity)
  - **SSGI** for screen-space indirect light and AO (WebGPU) or GTAO (fallback)
  - **SSR** for screen-space reflections, including dielectrics such as clear coat and asphalt sheen
  - **TRAA** temporal AA
  - motion blur as a reconstruction filter. It weighs every tap by depth and velocity, so the car stays sharp against a streaking background and doesn't smear into it. Taps are jittered per pixel and per frame, the shutter stays constant whatever the frame rate, and streak length is capped. Motion vectors advance once per frame per object; three's default advanced them per draw, which broke meshes with several material groups.
  - bloom
  - grading, vignette and grain
  
  - lens flare ghosts on High and Ultra
  
  Upscaling: Medium and High render internally at 70% and 80% and reconstruct full resolution with TAAU temporal upscaling; Ultra uses native TRAA. Auto exposure (eye adaptation) uses a GPU luminance meter read back asynchronously.
  
  Everything else is ACES filmic tone mapping. Quality presets are Low, Medium, High and Ultra. drei's `PerformanceMonitor` adapts the render resolution when the frame rate drops.
- **Cars** (`src/car`): bodies are sculpted as **signed distance fields**, meshed with Surface Nets and snapped back onto the exact surface:
  - lofted tub and greenhouse, smooth-blended fenders, cut wheel arches, intakes, vents and a Kamm tail
  - triangles are classified into paint, glass, carbon, lights, grille and wheel wells
  - clear-coat metallic-flake paint with a procedural livery and race numbers
  - lathe tyres with sidewall lettering, multi-spoke rims and centre locks
  - brake discs that glow with the simulated brake temperature
  - airfoil wing, cockpit with a driver and a steering wheel that turns
- **World**:
  - procedural tileable PBR textures: asphalt with real aggregate, grass, gravel, concrete
  - the racing line is rubbered into the road shader
  - terrain blended into hills and an alpine mountain ring
  - armco, painted concrete walls, tyre walls, catch fences
  - grandstands with crowds, pit building, start gantry with working lights, bridge, billboards, 300/200/100 m boards, marshal posts
  - card-based foliage trees in chunked LODs with wind sway
- **Effects**: tyre smoke, dust on grass and gravel, skid marks and sparks.
  - Smoke comes from the contact patch in proportion to friction power above the vaporisation onset, and more from a hot tread.
  - Each puff rides the car's wake, rises with buoyancy while hot, wanders with turbulence, rolls along the road, and grows by turbulent diffusion while its optical depth falls as 1/r² (mass conserved).
  - Particles render in their own pass, composited over the lit image and sorted back to front. They fade softly against the scene depth instead of cutting into the road. The smoke is shaded as a scattering medium: sun lighting with self-shadowing along the light path, sky light from the environment, and Henyey-Greenstein forward scattering (thin smoke glows against the sun).
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
- Browsers expose no force feedback for steering wheels, so wheels get no FFB. Gamepads get rumble.
- Set `VITE_SPEED_SERVER=wss://host/ws` at build time to point the client at a separately hosted server.
