// Car definitions, tunable setup and tyre compounds.
import { DEG } from './math'

export type Drivetrain = 'RWD' | 'AWD'

export interface TyreSpec {
  radius: number // unloaded radius (m)
  width: number // section width (m)
  inertia: number // wheel+tyre+disc spin inertia (kg m^2)
  vertStiffness: number // N/m
  vertDamping: number // N s/m
  relaxLong: number // m
  relaxLat: number // m
}

export interface CompoundSpec {
  id: string
  name: string
  mu: number // peak lateral friction at nominal load & optimal temp
  muLong: number // longitudinal/lateral peak ratio
  loadSens: number // fractional friction loss per Fz/Fz0 above nominal
  nominalLoad: number // N
  peakSlipAngle: number // rad
  peakSlipRatio: number
  slideLat: number // sliding/peak friction ratio, lateral
  slideLong: number // sliding/peak friction ratio, longitudinal
  optTemp: number // optimal surface temperature (C)
  tempWindow: number // half-width of the grip window (C)
  tempGripLoss: number // grip loss at one window width outside of optimum
  heatGain: number // multiplier on slip power going into the tread
  wearRate: number
  rollingRes: number
}

export const COMPOUNDS: Record<string, CompoundSpec> = {
  RS: { id: 'RS', name: 'Racing Soft', mu: 1.72, muLong: 1.04, loadSens: 0.13, nominalLoad: 3500, peakSlipAngle: 6.8 * DEG, peakSlipRatio: 0.095, slideLat: 0.78, slideLong: 0.8, optTemp: 92, tempWindow: 22, tempGripLoss: 0.07, heatGain: 1.15, wearRate: 1.6, rollingRes: 0.011 },
  RM: { id: 'RM', name: 'Racing Medium', mu: 1.64, muLong: 1.04, loadSens: 0.13, nominalLoad: 3500, peakSlipAngle: 7.0 * DEG, peakSlipRatio: 0.1, slideLat: 0.8, slideLong: 0.82, optTemp: 98, tempWindow: 25, tempGripLoss: 0.06, heatGain: 1.0, wearRate: 1.0, rollingRes: 0.011 },
  RH: { id: 'RH', name: 'Racing Hard', mu: 1.56, muLong: 1.04, loadSens: 0.12, nominalLoad: 3500, peakSlipAngle: 7.2 * DEG, peakSlipRatio: 0.105, slideLat: 0.82, slideLong: 0.84, optTemp: 105, tempWindow: 28, tempGripLoss: 0.05, heatGain: 0.85, wearRate: 0.6, rollingRes: 0.011 },
  SS: { id: 'SS', name: 'Sports Soft', mu: 1.28, muLong: 1.02, loadSens: 0.11, nominalLoad: 4000, peakSlipAngle: 8.5 * DEG, peakSlipRatio: 0.12, slideLat: 0.84, slideLong: 0.86, optTemp: 78, tempWindow: 35, tempGripLoss: 0.05, heatGain: 1.05, wearRate: 0.7, rollingRes: 0.013 },
  SM: { id: 'SM', name: 'Sports Medium', mu: 1.18, muLong: 1.02, loadSens: 0.1, nominalLoad: 4000, peakSlipAngle: 9 * DEG, peakSlipRatio: 0.13, slideLat: 0.86, slideLong: 0.88, optTemp: 75, tempWindow: 40, tempGripLoss: 0.04, heatGain: 0.95, wearRate: 0.5, rollingRes: 0.014 },
}

export interface EngineSpec {
  /** full-load (full boost) torque curve [rpm, Nm] */
  torque: ReadonlyArray<readonly [number, number]>
  idleRpm: number
  limiterRpm: number
  maxRpm: number
  inertia: number // crank + flywheel + clutch, kg m^2
  /** engine braking torque = a + b * rpm/1000 (Nm) when throttle closed */
  dragA: number
  dragB: number
  turbo?: { naFraction: number; spoolRpm: number; fullRpm: number; spoolUp: number; spoolDown: number; maxBoost: number }
  cylinders: number
  /** for audio: firing layout */
  layout: 'V8-cross' | 'V8-flat' | 'I6' | 'V10' | 'V12' | 'F6'
}

export interface SuspensionAxle {
  unsprungMass: number // per corner
  motionRatio: number
  rollCenter: number // m above ground where lateral forces are reacted
  camberGain: number // rad per m of compression (negative = more negative camber under bump)
  bumpTravel: number // m from static to bump stop
  droopTravel: number // m below static allowed
  bumpStopRate: number // N/m^2 progressive
  fastKnee: number // damper knee speed (m/s)
}

export interface AeroSpec {
  cdA: number
  /** downforce coefficient * area for front / rear at reference ride height and wing level 0 */
  clAFront: number
  clARear: number
  /** additional clA per wing step */
  wingFrontStep: number
  wingRearStep: number
  /** drag increase per unit of total clA added by wings */
  dragPerDownforce: number
  /** downforce gain per metre of ride height reduction (fraction) */
  rideSens: number
  refRideHeight: number // m
  /** height of drag application above CoG */
  dragHeight: number
}

export interface CarSpec {
  id: string
  name: string
  manufacturer: string
  category: string
  description: string
  mass: number // total incl. driver
  weightFront: number // static front weight fraction
  cgHeight: number // at nominal ride height
  wheelbase: number
  trackFront: number
  trackRear: number
  inertiaScale: [number, number, number] // multipliers on box inertia (x pitch?, y yaw, z roll) - see Vehicle
  length: number
  width: number
  height: number
  frontOverhang: number
  rearOverhang: number
  drivetrain: Drivetrain
  awdFrontShare?: number
  engine: EngineSpec
  gears: number[] // forward ratios
  reverse: number
  finalDrive: number
  shiftTime: number
  clutchTorque: number
  steerLock: number // rad at full lock (road wheel)
  ackermann: number // 0..1
  brakeTorque: number // total max brake torque (Nm) at 100% pressure, all 4 wheels
  handbrakeTorque: number
  tyreFront: TyreSpec
  tyreRear: TyreSpec
  suspFront: SuspensionAxle
  suspRear: SuspensionAxle
  aero: AeroSpec
  defaultSetup: CarSetup
  /** visuals */
  bodyStyle: 'gt3' | 'coupe' | 'proto'
  defaultColor: string
}

export interface CarSetup {
  compound: string
  pressureF: number // bar (cold)
  pressureR: number
  brakeBias: number // front fraction
  brakePressure: number // 0.7..1
  springF: number // wheel rate N/mm
  springR: number
  bumpF: number // N s/m
  bumpR: number
  reboundF: number
  reboundR: number
  arbF: number // N/mm (at wheel)
  arbR: number
  rideHeightF: number // mm
  rideHeightR: number
  camberF: number // deg (negative = top inwards)
  camberR: number
  toeF: number // deg (positive = toe-in)
  toeR: number
  diffPreload: number // Nm
  diffPower: number // 0..1
  diffCoast: number // 0..1
  wingF: number // steps 0..10
  wingR: number
  finalDrive: number
  ballast: number // kg
}

const G = 9.81

export const CARS: CarSpec[] = [
  {
    id: 'vanta-gt3',
    name: 'Vanta R-GT3',
    manufacturer: 'Vanta',
    category: 'Gr.3 · Race',
    description: 'Mid-engine twin-turbo V8 race car. Slick tyres, serious downforce, sequential paddle-shift gearbox.',
    mass: 1340,
    weightFront: 0.44,
    cgHeight: 0.43,
    wheelbase: 2.72,
    trackFront: 1.69,
    trackRear: 1.66,
    inertiaScale: [1.0, 1.0, 1.0],
    length: 4.62,
    width: 2.04,
    height: 1.19,
    frontOverhang: 1.0,
    rearOverhang: 0.9,
    drivetrain: 'RWD',
    engine: {
      torque: [
        [800, 260],
        [1500, 360],
        [2500, 520],
        [3500, 640],
        [4500, 690],
        [5500, 700],
        [6500, 668],
        [7200, 618],
        [7800, 560],
        [8400, 470],
      ],
      idleRpm: 1100,
      limiterRpm: 8100,
      maxRpm: 8600,
      inertia: 0.22,
      dragA: 22,
      dragB: 9,
      turbo: { naFraction: 0.62, spoolRpm: 2200, fullRpm: 4200, spoolUp: 0.35, spoolDown: 0.18, maxBoost: 1.4 },
      cylinders: 8,
      layout: 'V8-flat',
    },
    gears: [3.08, 2.31, 1.83, 1.5, 1.27, 1.1],
    reverse: -2.9,
    finalDrive: 3.36,
    shiftTime: 0.055,
    clutchTorque: 1300,
    steerLock: 24 * DEG,
    ackermann: 0.25,
    brakeTorque: 10400,
    handbrakeTorque: 2400,
    tyreFront: { radius: 0.338, width: 0.305, inertia: 1.15, vertStiffness: 290000, vertDamping: 420, relaxLong: 0.12, relaxLat: 0.32 },
    tyreRear: { radius: 0.352, width: 0.325, inertia: 1.3, vertStiffness: 300000, vertDamping: 420, relaxLong: 0.12, relaxLat: 0.34 },
    suspFront: { unsprungMass: 32, motionRatio: 1, rollCenter: 0.05, camberGain: -0.35, bumpTravel: 0.045, droopTravel: 0.05, bumpStopRate: 3.2e7, fastKnee: 0.12 },
    suspRear: { unsprungMass: 36, motionRatio: 1, rollCenter: 0.08, camberGain: -0.3, bumpTravel: 0.05, droopTravel: 0.055, bumpStopRate: 3.2e7, fastKnee: 0.12 },
    aero: { cdA: 0.92, clAFront: 1.15, clARear: 1.55, wingFrontStep: 0.06, wingRearStep: 0.11, dragPerDownforce: 0.07, rideSens: 2.6, refRideHeight: 0.07, dragHeight: 0.12 },
    defaultSetup: {
      compound: 'RM',
      // cold pressures that reach ~1.9 bar once the tyres are at working temperature
      pressureF: 1.4,
      pressureR: 1.34,
      brakeBias: 0.575,
      brakePressure: 1,
      springF: 150,
      springR: 138,
      bumpF: 6200,
      bumpR: 6400,
      reboundF: 9400,
      reboundR: 9800,
      arbF: 80,
      arbR: 46,
      rideHeightF: 64,
      rideHeightR: 76,
      camberF: -3.4,
      camberR: -2.6,
      toeF: -0.06,
      toeR: 0.18,
      diffPreload: 90,
      diffPower: 0.42,
      diffCoast: 0.3,
      wingF: 4,
      wingR: 5,
      finalDrive: 3.36,
      ballast: 0,
    },
    bodyStyle: 'gt3',
    defaultColor: '#c8102e',
  },
  {
    id: 'aurel-gt',
    name: 'Aurel 660 GT',
    manufacturer: 'Aurel',
    category: 'Gr.N · Road',
    description: 'Front-mid engine grand tourer. 660 PS twin-turbo V8 on sports tyres — playful, heavy and fast.',
    mass: 1620,
    weightFront: 0.5,
    cgHeight: 0.5,
    wheelbase: 2.78,
    trackFront: 1.66,
    trackRear: 1.64,
    inertiaScale: [1.05, 1.05, 1.0],
    length: 4.7,
    width: 1.98,
    height: 1.28,
    frontOverhang: 1.0,
    rearOverhang: 0.92,
    drivetrain: 'RWD',
    engine: {
      torque: [
        [800, 300],
        [1500, 450],
        [2200, 700],
        [3000, 780],
        [4500, 780],
        [5500, 770],
        [6500, 712],
        [7200, 640],
        [7600, 560],
      ],
      idleRpm: 850,
      limiterRpm: 7400,
      maxRpm: 7800,
      inertia: 0.28,
      dragA: 26,
      dragB: 10,
      turbo: { naFraction: 0.55, spoolRpm: 1600, fullRpm: 3200, spoolUp: 0.42, spoolDown: 0.22, maxBoost: 1.2 },
      cylinders: 8,
      layout: 'V8-cross',
    },
    gears: [3.4, 2.36, 1.73, 1.32, 1.06, 0.88, 0.72],
    reverse: -3.1,
    finalDrive: 3.31,
    shiftTime: 0.11,
    clutchTorque: 1250,
    steerLock: 32 * DEG,
    ackermann: 0.55,
    brakeTorque: 9600,
    handbrakeTorque: 2600,
    tyreFront: { radius: 0.348, width: 0.265, inertia: 1.3, vertStiffness: 250000, vertDamping: 380, relaxLong: 0.14, relaxLat: 0.42 },
    tyreRear: { radius: 0.356, width: 0.305, inertia: 1.45, vertStiffness: 260000, vertDamping: 380, relaxLong: 0.14, relaxLat: 0.45 },
    suspFront: { unsprungMass: 42, motionRatio: 1, rollCenter: 0.06, camberGain: -0.25, bumpTravel: 0.07, droopTravel: 0.08, bumpStopRate: 2.0e7, fastKnee: 0.15 },
    suspRear: { unsprungMass: 46, motionRatio: 1, rollCenter: 0.1, camberGain: -0.2, bumpTravel: 0.075, droopTravel: 0.085, bumpStopRate: 2.0e7, fastKnee: 0.15 },
    aero: { cdA: 0.8, clAFront: 0.18, clARear: 0.28, wingFrontStep: 0.02, wingRearStep: 0.04, dragPerDownforce: 0.1, rideSens: 1.2, refRideHeight: 0.11, dragHeight: 0.15 },
    defaultSetup: {
      compound: 'SS',
      pressureF: 2.2,
      pressureR: 2.2,
      brakeBias: 0.6,
      brakePressure: 1,
      springF: 52,
      springR: 58,
      bumpF: 3600,
      bumpR: 3800,
      reboundF: 5600,
      reboundR: 6000,
      arbF: 34,
      arbR: 22,
      rideHeightF: 110,
      rideHeightR: 115,
      camberF: -1.6,
      camberR: -1.3,
      toeF: 0.0,
      toeR: 0.15,
      diffPreload: 60,
      diffPower: 0.32,
      diffCoast: 0.18,
      wingF: 0,
      wingR: 0,
      finalDrive: 3.31,
      ballast: 0,
    },
    bodyStyle: 'coupe',
    defaultColor: '#1d3b6e',
  },
]

export function getCar(id: string): CarSpec {
  return CARS.find((c) => c.id === id) ?? CARS[0]
}

/** Natural frequency (Hz) of a corner given wheel rate (N/mm) and sprung corner mass (kg). */
export function rideFrequency(springNmm: number, cornerMass: number) {
  return Math.sqrt((springNmm * 1000) / cornerMass) / (2 * Math.PI)
}

export function cornerSprungMass(spec: CarSpec, front: boolean, setup: CarSetup) {
  const m = spec.mass + setup.ballast
  const unsprung = 2 * (spec.suspFront.unsprungMass + spec.suspRear.unsprungMass)
  const sprung = m - unsprung
  return (sprung * (front ? spec.weightFront : 1 - spec.weightFront)) / 2
}

export const GRAVITY = G
