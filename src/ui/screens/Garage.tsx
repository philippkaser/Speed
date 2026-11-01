import { useState } from 'react'
import { game } from '../../game/game'
import { startAttract, startShowroom } from '../../game/session'
import { CARS, COMPOUNDS, cornerSprungMass, getCar, rideFrequency, type CarSetup } from '../../physics/spec'
import { useGameStore } from '../../state/gameStore'
import { Btn, Segmented, Slider } from '../components'
import { BottomBar, carStats, TopBar } from './Home'

const PAINTS = ['#c8102e', '#e4002b', '#ff6f00', '#f5b800', '#2e7d32', '#00838f', '#0d47a1', '#1d3b6e', '#6a1b9a', '#f2f2f0', '#9ea3a8', '#3c4045', '#0a0a0c', '#b08d57', '#00bcd4', '#c51162']

export function Garage() {
  const g = useGameStore()
  const [tab, setTab] = useState<'car' | 'tuning'>('car')
  const carId = g.career.carId
  const spec = getCar(carId)
  const color = g.career.colors[carId] ?? spec.defaultColor
  const st = carStats(spec)

  const selectCar = (id: string) => {
    g.updateCareer((c) => ({ ...c, carId: id }))
    setTimeout(startShowroom, 0)
  }
  const setColor = (c: string) => {
    g.updateCareer((cr) => ({ ...cr, colors: { ...cr.colors, [carId]: c } }))
    setTimeout(startShowroom, 0)
  }

  return (
    <>
      <TopBar crumb="Garage" />
      <div className="screen" style={{ justifyContent: 'space-between' }}>
        <div className="panel" style={{ width: 340, display: 'flex', flexDirection: 'column', alignSelf: 'flex-start', maxHeight: '100%' }}>
          <div className="panel-head">
            <h2>Cars</h2>
          </div>
          <div className="panel-body">
            <div className="car-list">
              {CARS.map((c) => {
                const s = carStats(c)
                return (
                  <button key={c.id} className={'car-item' + (c.id === carId ? ' on' : '')} onClick={() => selectCar(c.id)}>
                    <div className="caps" style={{ fontSize: 10 }}>
                      {c.manufacturer}
                    </div>
                    <div className="n">{c.name}</div>
                    <div className="c">
                      {c.category} · {s.ps} PS · {c.mass} kg
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="section-title" style={{ marginTop: 22 }}>
              Paint
            </div>
            <div className="swatches">
              {PAINTS.map((p) => (
                <button key={p} className={'swatch' + (p.toLowerCase() === color.toLowerCase() ? ' on' : '')} style={{ background: p }} onClick={() => setColor(p)} aria-label={'paint ' + p} />
              ))}
            </div>
          </div>
        </div>

        <div className="panel" style={{ width: 'min(620px, 52vw)', display: 'flex', flexDirection: 'column', maxHeight: '100%' }}>
          <div className="tabs">
            <button className={tab === 'car' ? 'on' : ''} onClick={() => setTab('car')}>
              Specifications
            </button>
            <button className={tab === 'tuning' ? 'on' : ''} onClick={() => setTab('tuning')}>
              Tuning
            </button>
          </div>
          <div className="panel-body" style={{ flex: 1 }}>
            {tab === 'car' ? (
              <div>
                <div className="caps">{spec.manufacturer}</div>
                <div style={{ fontSize: 30, fontWeight: 600, margin: '4px 0 6px' }}>{spec.name}</div>
                <div style={{ color: 'var(--muted)', lineHeight: 1.5, fontSize: 14 }}>{spec.description}</div>
                <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                  <div className="stat">
                    <span className="v num">{st.ps}</span>
                    <span className="u">PS</span>
                    <div className="l">@ {st.peakRpm} rpm</div>
                  </div>
                  <div className="stat">
                    <span className="v num">{st.torque}</span>
                    <span className="u">Nm</span>
                    <div className="l">Torque</div>
                  </div>
                  <div className="stat">
                    <span className="v num">{st.kg}</span>
                    <span className="u">kg</span>
                    <div className="l">Weight</div>
                  </div>
                  <div className="stat">
                    <span className="v num">{st.pw}</span>
                    <span className="u">kg/PS</span>
                    <div className="l">Ratio</div>
                  </div>
                </div>
                <div className="section-title" style={{ marginTop: 22 }}>
                  Chassis
                </div>
                <SpecRow k="Layout" v={`${spec.bodyStyle === 'coupe' ? 'Front-mid engine' : 'Mid engine'}, ${spec.drivetrain}`} />
                <SpecRow k="Engine" v={`${spec.engine.cylinders}-cyl twin-turbo, ${spec.engine.layout === 'V8-flat' ? 'flat-plane' : 'cross-plane'} crank`} />
                <SpecRow k="Gearbox" v={`${spec.gears.length}-speed sequential, ${Math.round(spec.shiftTime * 1000)} ms shifts`} />
                <SpecRow k="Wheelbase / Track" v={`${spec.wheelbase.toFixed(2)} m / ${spec.trackFront.toFixed(2)} m`} />
                <SpecRow k="Weight distribution" v={`${Math.round(spec.weightFront * 100)} : ${Math.round((1 - spec.weightFront) * 100)}`} />
                <SpecRow k="Tyres" v={`${Math.round(spec.tyreFront.width * 1000)}/${Math.round(spec.tyreRear.width * 1000)} · ${COMPOUNDS[spec.defaultSetup.compound].name}`} />
                <SpecRow k="Downforce @ 200 km/h" v={`${Math.round(0.6 * (spec.aero.clAFront + spec.aero.clARear) * 55.6 ** 2 / 9.81)} kg`} />
              </div>
            ) : (
              <Tuning />
            )}
          </div>
        </div>
      </div>
      <BottomBar
        hints={[
          ['Drag', 'Rotate camera'],
          ['Wheel', 'Zoom'],
        ]}
      />
      <div style={{ position: 'absolute', right: 36, bottom: 70, display: 'flex', gap: 10 }}>
        <Btn
          sound="back"
          onClick={() => {
            startAttract()
            g.setScreen('home')
          }}
        >
          Back
        </Btn>
      </div>
    </>
  )
}

function SpecRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="field" style={{ gridTemplateColumns: '1fr auto' }}>
      <div className="lab" style={{ color: 'var(--muted)' }}>
        {k}
      </div>
      <div style={{ fontWeight: 600 }}>{v}</div>
    </div>
  )
}

export function Tuning() {
  const g = useGameStore()
  const carId = g.career.carId
  const spec = getCar(carId)
  const setup: CarSetup = g.career.setups[carId] ?? spec.defaultSetup
  const set = (patch: Partial<CarSetup>) => {
    const next = { ...setup, ...patch }
    g.updateCareer((c) => ({ ...c, setups: { ...c.setups, [carId]: next } }))
    // live update of the showroom / track car
    if (game.player) game.player.sim.vehicle.applySetup(next)
  }
  const fF = rideFrequency(setup.springF, cornerSprungMass(spec, true, setup))
  const fR = rideFrequency(setup.springR, cornerSprungMass(spec, false, setup))
  const clF = spec.aero.clAFront + setup.wingF * spec.aero.wingFrontStep
  const clR = spec.aero.clARear + setup.wingR * spec.aero.wingRearStep
  const df200 = (0.6 * (clF + clR) * 55.6 ** 2) / 9.81
  const balance = (clF / (clF + clR)) * 100
  const dual = (k1: keyof CarSetup, k2: keyof CarSetup, label: string, min: number, max: number, step: number, unit: string, fmt?: (v: number) => string) => (
    <>
      <Slider label={label + ' · Front'} value={setup[k1] as number} min={min} max={max} step={step} unit={unit} format={fmt} onChange={(v) => set({ [k1]: v } as Partial<CarSetup>)} />
      <Slider label={label + ' · Rear'} value={setup[k2] as number} min={min} max={max} step={step} unit={unit} format={fmt} onChange={(v) => set({ [k2]: v } as Partial<CarSetup>)} />
    </>
  )
  return (
    <div>
      <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 0, paddingTop: 0, borderTop: 'none', marginBottom: 12 }}>
        <div className="stat">
          <span className="v num">{fF.toFixed(2)}</span>
          <span className="u">Hz</span>
          <div className="l">Ride freq F</div>
        </div>
        <div className="stat">
          <span className="v num">{fR.toFixed(2)}</span>
          <span className="u">Hz</span>
          <div className="l">Ride freq R</div>
        </div>
        <div className="stat">
          <span className="v num">{Math.round(df200)}</span>
          <span className="u">kg</span>
          <div className="l">DF @200</div>
        </div>
        <div className="stat">
          <span className="v num">{balance.toFixed(1)}</span>
          <span className="u">% F</span>
          <div className="l">Aero bal.</div>
        </div>
      </div>
      <div className="section-title">Tyres</div>
      <div className="field" style={{ gridTemplateColumns: '1fr auto' }}>
        <div className="lab">Compound</div>
        <Segmented options={Object.values(COMPOUNDS).map((c) => ({ value: c.id, label: c.id }))} value={setup.compound} onChange={(v) => set({ compound: v })} />
      </div>
      {dual('pressureF', 'pressureR', 'Cold pressure', 1.1, 2.8, 0.05, 'bar', (v) => v.toFixed(2))}
      <div className="section-title">Brakes</div>
      <Slider label="Brake balance" sub="Share of braking torque at the front" value={setup.brakeBias} min={0.45} max={0.75} step={0.005} unit="% F" format={(v) => (v * 100).toFixed(1)} onChange={(v) => set({ brakeBias: v })} />
      <Slider label="Brake pressure" value={setup.brakePressure} min={0.7} max={1} step={0.01} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => set({ brakePressure: v })} />
      <div className="section-title">Suspension</div>
      {dual('rideHeightF', 'rideHeightR', 'Ride height', 40, 140, 1, 'mm')}
      {dual('springF', 'springR', 'Wheel rate', 20, 260, 1, 'N/mm')}
      {dual('bumpF', 'bumpR', 'Bump damping', 1000, 14000, 100, 'Ns/m')}
      {dual('reboundF', 'reboundR', 'Rebound damping', 2000, 18000, 100, 'Ns/m')}
      {dual('arbF', 'arbR', 'Anti-roll bar', 0, 180, 1, 'N/mm')}
      {dual('camberF', 'camberR', 'Camber', -5, 0, 0.1, '°', (v) => v.toFixed(1))}
      {dual('toeF', 'toeR', 'Toe (in +)', -0.5, 0.5, 0.01, '°', (v) => v.toFixed(2))}
      <div className="section-title">Differential</div>
      <Slider label="Preload" value={setup.diffPreload} min={0} max={300} step={5} unit="Nm" onChange={(v) => set({ diffPreload: v })} />
      <Slider label="Lock under power" value={setup.diffPower} min={0} max={0.9} step={0.01} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => set({ diffPower: v })} />
      <Slider label="Lock on coast" value={setup.diffCoast} min={0} max={0.9} step={0.01} unit="%" format={(v) => Math.round(v * 100) + ''} onChange={(v) => set({ diffCoast: v })} />
      <div className="section-title">Aerodynamics</div>
      {dual('wingF', 'wingR', 'Downforce level', 0, 10, 1, '')}
      <div className="section-title">Transmission & weight</div>
      <Slider label="Final drive" sub="Lower = higher top speed" value={setup.finalDrive} min={2.6} max={4.4} step={0.01} format={(v) => v.toFixed(2)} onChange={(v) => set({ finalDrive: v })} />
      <Slider label="Ballast" value={setup.ballast} min={0} max={120} step={5} unit="kg" onChange={(v) => set({ ballast: v })} />
      <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
        <Btn ghost sound="back" onClick={() => set({ ...spec.defaultSetup })}>
          Reset to default
        </Btn>
      </div>
    </div>
  )
}
