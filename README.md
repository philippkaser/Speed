# SPEED

A browser racing game built with **React 19, Bun, Vite, React Three Fiber, drei and three.js (WebGPU / TSL)**.
Everything — car bodies, circuit, textures, scenery, engine sound — is generated procedurally at load time. There are no downloaded assets.

```bash
bun install
bun run dev      # Vite (http://localhost:5173) + multiplayer server (:3001), Vite proxies /ws
bun run build    # type-check + production bundle in dist/
bun run start    # production: one Bun process serves dist/ and the WebSocket server on :3001
bun test         # physics, AI and multiplayer integration tests
```

Useful URL switches: `?drive` (straight into a practice session), `?race`, `?showroom`, `?car=aurel-gt`, `?q=low|medium|high|ultra`, `?webgl` (force the WebGL2 backend), `?autopilot` (AI drives your car).

---

## What's inside

### Vehicle dynamics (`src/physics`)
A rigid-body simulation at a fixed **600 Hz**, independent of the frame rate, with interpolated rendering.

- **Tyres** (`tyre.ts`): transient combined-slip model. A Magic-Formula-shaped force curve acts on a normalised combined slip vector, with separate peak slip, friction and post-peak fall-off for each direction. Contact-patch relaxation lengths are integrated implicitly, so the model stays stable down to standstill, where it behaves as a damped spring (static friction). It also covers:
  - load sensitivity
  - camber (a lean into the load helps up to an optimum) and camber thrust
  - a two-node thermal model (tread surface and carcass) driven by contact-patch slip power and rolling hysteresis
  - hot pressure from the ideal gas law, which feeds back into grip and stiffness
  - wear
  - five compounds (Racing Soft/Medium/Hard, Sports Soft/Medium) with different windows
- **Suspension**:
  - every corner has its own unsprung mass (wheel hop) with vertical tyre stiffness and damping
  - bilinear bump/rebound dampers, progressive bump stops and droop limits
  - anti-roll bars, camber gain, roll-centre force application
  - Ackermann and toe steering geometry
- **Drivetrain**:
  - an engine with a torque map, turbo spool with lag, a rev limiter, engine braking and idle control
  - a friction clutch (auto clutch on launch, never stalls)
  - a sequential gearbox with ignition cut and auto-blip
  - a clutch-pack LSD with preload and power/coast ramps
  - brakes with temperature and fade
  
  The drivetrain is solved as velocity constraints with projected Gauss–Seidel impulses, so clutch lock-up, diff lock and wheel lock all emerge from friction limits.
- **Aero**: drag plus front/rear downforce that responds to ride height, rake and yaw; adjustable wing levels; slipstream behind other cars.
- **Assists**: ABS (per-wheel slip control), traction control (5 levels), a steering assist for keyboard and pad (slip-angle targeted, with auto counter-steer), and an automatic gearbox. All of these can be switched off.
- **Collisions**: hull probes against barriers and the ground (sparks when bottoming), and car-to-car SAT boxes with impulses.

Measured in `bun test` (flat ground, warm tyres):

| | Vanta R-GT3 (slicks) | Aurel 660 GT (sports tyres) |
|---|---|---|
| 0–100 km/h | 3.6 s | 4.7 s |
| top speed | 281 km/h (gearing) | 323 km/h (drag) |
| 200–0 km/h | 80 m, 2.3 g peak | 130 m |
| skidpad (R 60 m) | 1.51 g | 1.04 g |

### Circuit (`src/track`)
*Autodromo Valle Alta* is an original 4.6 km layout. It's a closed centripetal Catmull-Rom spline with elevation, banking and variable width. From that spline the build automatically generates:
- kerbs on apexes and exits, with rumble ridges
- asphalt or gravel runoff chosen by corner speed
- barriers kept clear of other parts of the track
- a minimum-curvature racing line and a quasi-steady-state speed profile, which are used by the AI, the driving line and the brake boards

`track.ts` implements the physics ground query (height, normal, surface type, track coordinates and barriers) in O(1) using spatial hints. `bun scripts/plot-track.ts out.svg` renders the layout.

### Rendering (`src/render`)
`WebGPURenderer` inside R3F. It falls back automatically to the WebGL2 backend when WebGPU is unavailable, and all materials are written in TSL so the same code runs on both.

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
  - motion blur with a constant 1/60 s shutter
  - bloom
  - grading, vignette and grain
  
  Everything else is ACES filmic tone mapping. Quality presets are Low, Medium, High and Ultra.
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
- **Effects**: tyre smoke driven by contact-patch slip power, dust on grass and gravel, skid marks, sparks.
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
| HUD | H | D-pad up |
| Pause | Esc / P | Start |

## Notes
- WebGPU gives the full pipeline (SSGI). On the WebGL2 fallback, SSGI is replaced by GTAO and everything else stays.
- Browsers expose no force feedback for steering wheels, so wheels get no FFB. Gamepads get rumble.
- Set `VITE_SPEED_SERVER=wss://host/ws` at build time to point the client at a separately hosted server.
