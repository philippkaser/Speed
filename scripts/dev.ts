// Runs the Vite dev server and the Bun multiplayer server together.
const procs = [
  Bun.spawn(['bun', '--watch', 'server/index.ts'], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env } }),
  Bun.spawn(['bunx', '--bun', 'vite'], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env } }),
]
const stop = () => {
  for (const p of procs) p.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await Promise.race(procs.map((p) => p.exited))
stop()
