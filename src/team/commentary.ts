// Live commentary: broadcast lines from race events, optionally spoken (Web Speech API).
import { fmtTime } from '../ui/components'
import { TYRES } from './strategy'
import type { Stamped, TeamRace } from './teamRace'

const one = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)]

export interface Line {
  text: string
  /** worth saying out loud */
  big: boolean
}

export function commentaryFor(e: Stamped, tr: TeamRace): Line | null {
  const n = (id: string) => tr.byId.get(id)?.driver.last ?? id
  const mine = (id: string) => !!tr.byId.get(id)?.mine
  switch (e.kind) {
    case 'start':
      return { text: one(['Lights out and away we go!', 'And they are away! Clean start off the line.', 'Lights out! The field charges down to turn one.']), big: true }
    case 'overtake': {
      const top = e.pos <= 3
      if (!top && e.pos > 8 && !mine(e.car) && !mine(e.other)) return null
      return {
        text: top
          ? one([`${n(e.car)} takes P${e.pos} from ${n(e.other)}!`, `What a move! ${n(e.car)} is past ${n(e.other)} for P${e.pos}!`, `${n(e.car)} makes it stick on ${n(e.other)}, up to P${e.pos}.`])
          : one([`${n(e.car)} is through on ${n(e.other)}, up to P${e.pos}.`, `${n(e.car)} gets the job done on ${n(e.other)}.`, `Into P${e.pos} goes ${n(e.car)}.`]),
        big: top || mine(e.car) || mine(e.other),
      }
    }
    case 'lead':
      return { text: one([`${n(e.car)} takes the lead!`, `New race leader: ${n(e.car)}!`]), big: true }
    case 'battle':
      return { text: one([`${n(e.car)} is all over the back of ${n(e.other)} for P${e.pos + 1}.`, `Watch this one: ${n(e.car)} closing right in on ${n(e.other)}.`, `${n(e.other)} under real pressure from ${n(e.car)}.`]), big: e.pos <= 4 }
    case 'pit': {
      const c = tr.byId.get(e.car)
      if (!c) return null
      const pos = c.entry.timing.position
      if (e.phase === 'in' && (pos <= 6 || c.mine)) return { text: one([`${n(e.car)} peels into the pit lane.`, `In comes ${n(e.car)} from P${pos}.`, `${n(e.car)} is boxing this lap.`]), big: pos <= 3 || c.mine }
      if (e.phase === 'out')
        return e.slow
          ? { text: `Slow stop for ${n(e.car)}! ${e.time!.toFixed(1)} seconds stationary.`, big: true }
          : pos <= 8 || c.mine
            ? { text: `${n(e.car)} away on ${TYRES[e.compound!].name.toLowerCase()}s, ${e.time!.toFixed(1)} seconds stationary.`, big: false }
            : null
      return null
    }
    case 'undercut':
      return { text: one([`The strategy has worked for ${n(e.car)}! Jumps ${n(e.other)} in the pit cycle.`, `Undercut! ${n(e.car)} comes out ahead of ${n(e.other)}.`, `${n(e.car)} gains P${e.pos} on strategy, ${n(e.other)} loses out.`]), big: e.pos <= 5 || mine(e.car) || mine(e.other) }
    case 'fastest':
      return { text: `Fastest lap for ${n(e.car)}, ${fmtTime(e.time)}.`, big: false }
    case 'mistake':
      return { text: one([`Big moment for ${n(e.car)}!`, `${n(e.car)} locks up and runs wide!`, `Oh! ${n(e.car)} nearly lost it there.`]), big: true }
    case 'retire':
      return { text: `${n(e.car)} is out of the race. ${e.reason}.`, big: true }
    case 'lastLap': {
      const lead = tr.game.standings()[0]
      return { text: `Last lap! ${lead ? n(lead.id) : ''} leads the way.`, big: true }
    }
    case 'chequered':
      return { text: one([`${n(e.car)} takes the chequered flag! What a drive!`, `${n(e.car)} wins it!`]), big: true }
    default:
      return null
  }
}

let voice: SpeechSynthesisVoice | null = null
export function speak(text: string) {
  if (typeof speechSynthesis === 'undefined') return
  try {
    if (!voice) voice = speechSynthesis.getVoices().find((v) => /en-GB/i.test(v.lang)) ?? speechSynthesis.getVoices().find((v) => /^en/i.test(v.lang)) ?? null
    if (speechSynthesis.pending) speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    if (voice) u.voice = voice
    u.rate = 1.12
    u.pitch = 1.02
    u.volume = 0.9
    speechSynthesis.speak(u)
  } catch {
    /* no speech on this platform */
  }
}
