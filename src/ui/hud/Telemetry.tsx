// Engineering telemetry overlay (toggle with I): per-wheel tyre state, kinematics, aero, FFB.
import { useEffect, useRef, useState } from 'react'
import { game } from '../../game/game'
import { input } from '../../input/input'

const NAMES = ['FL', 'FR', 'RL', 'RR']

export function Telemetry() {
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLPreElement>(null)
  const ffbBar = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      input.on((a) => {
        if (a === 'telemetry') setOpen((o) => !o)
      }),
    [],
  )

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => {
      const p = game.player
      if (!p || !body.current) return
      const v = p.sim.vehicle
      const deg = 180 / Math.PI
      let txt = '      Fz[N]  α[°]   κ     slide  Mz[Nm]  γ[°]\n'
      v.wheels.forEach((w, i) => {
        const t = w.tyre
        const cam = (w.camberStatic + w.kin.camberAt(w.c - w.cStatic)) * deg
        txt += `${NAMES[i]}  ${t.Fz.toFixed(0).padStart(6)} ${(t.slipAngle * deg).toFixed(1).padStart(5)} ${t.slipRatio.toFixed(3).padStart(6)}  ${(t.sliding * 100).toFixed(0).padStart(3)}%  ${t.Mz.toFixed(0).padStart(6)} ${cam.toFixed(1).padStart(5)}\n`
      })
      const rcF = v.wheels[0].kin.rollCentreAt(((v.wheels[0].c - v.wheels[0].cStatic) + (v.wheels[1].c - v.wheels[1].cStatic)) / 2)
      const rcR = v.wheels[2].kin.rollCentreAt(((v.wheels[2].c - v.wheels[2].cStatic) + (v.wheels[3].c - v.wheels[3].cStatic)) / 2)
      txt += `\nride height F/R  ${(v.rideHeightF * 1000).toFixed(0)} / ${(v.rideHeightR * 1000).toFixed(0)} mm\n`
      txt += `roll centre F/R  ${(rcF * 1000).toFixed(0)} / ${(rcR * 1000).toFixed(0)} mm\n`
      txt += `downforce        ${(v.downforce / 9.81).toFixed(0)} kg  bal ${(v.aeroBalance * 100).toFixed(1)}% F\n`
      txt += `drag             ${v.dragForce.toFixed(0)} N   boost ${(v.engine.boost * 100).toFixed(0)}%\n`
      txt += `rack torque      ${v.rackTorque.toFixed(0)} Nm`
      body.current.textContent = txt
      if (ffbBar.current) {
        const f = Math.max(-1, Math.min(1, v.ffb))
        ffbBar.current.style.left = f < 0 ? `${50 + f * 50}%` : '50%'
        ffbBar.current.style.width = `${Math.abs(f) * 50}%`
      }
    }, 80)
    return () => clearInterval(id)
  }, [open])

  if (!open) return null
  return (
    <div className="hud-box telemetry">
      <div className="caps" style={{ marginBottom: 6 }}>
        Telemetry
      </div>
      <pre ref={body} />
      <div className="caps" style={{ marginTop: 6 }}>
        Force feedback
      </div>
      <div className="ffb-meter">
        <i ref={ffbBar} />
      </div>
    </div>
  )
}
