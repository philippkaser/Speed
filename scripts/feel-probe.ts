// Drive-feel audit: the player's car through typical situations with keyboard and pad inputs, the
// default assists, through the game's own input pipeline. See scripts/feel/probe.ts.
//   bun scripts/feel-probe.ts            all scenarios, a table
//   bun scripts/feel-probe.ts --json     the metrics as JSON
//   bun scripts/feel-probe.ts lane tap   only scenarios whose name contains one of the words
import { allScenarios, formatResults } from './feel/probe'

const args = process.argv.slice(2)
const json = args.includes('--json')
const filter = args.filter((a) => !a.startsWith('--'))
const t0 = performance.now()
let rs = allScenarios()
if (filter.length) rs = rs.filter((r) => filter.some((f) => r.name.includes(f)))
if (json) console.log(JSON.stringify(rs, null, 1))
else {
  console.log(formatResults(rs))
  console.log(`\n${rs.length} scenarios in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}
