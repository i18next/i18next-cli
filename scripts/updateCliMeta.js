import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const pkgPath = resolve(process.cwd(), 'package.json')
const cliPath = resolve(process.cwd(), 'src/cli.ts')

const pkgRaw = await readFile(pkgPath, 'utf8')
const pkg = JSON.parse(pkgRaw)
const name = pkg.name || ''
const description = pkg.description || ''
const version = pkg.version || ''

const cliRaw = await readFile(cliPath, 'utf8')

const replacement = `program\n  .name('${name}')\n  .description('${description}')\n  .version('${version}')`

// 1) Prefer replacing an existing chain that starts with "program" followed directly by a dot (.name).
//    This prevents matching the "program" token that appears inside "const program = ..."
const reChain = /\bprogram\b(?=\s*\.)[\s\S]*?\.name\([^)]*\)\s*\.description\([^)]*\)\s*\.version\([^)]*\)/s

let newCli = cliRaw

if (reChain.test(cliRaw)) {
  newCli = cliRaw.replace(reChain, replacement)
} else {
  // 2) If there's no such chain, try to find the program declaration (const/let/var program = ...)
  const declRe = /\b(?:const|let|var)\s+program\b[^;]*;?/
  const declMatch = cliRaw.match(declRe)

  if (declMatch && typeof declMatch.index === 'number') {
    // Insert the chain after the declaration (preserving the declaration)
    const insertPos = declMatch.index + declMatch[0].length
    const prefix = cliRaw.slice(0, insertPos)
    const suffix = cliRaw.slice(insertPos)
    // Keep spacing clean: add a blank line before the chain
    newCli = prefix + '\n\n' + replacement + suffix
  } else {
    // 3) Last-resort fallback: try to insert before .parse if present, otherwise before first 'program'
    const progIdx = cliRaw.indexOf('program')
    if (progIdx === -1) {
      throw new Error('No "program" token found in cli.ts — cannot insert metadata automatically.')
    }
    const parseIdx = cliRaw.indexOf('.parse', progIdx)
    const insertBefore = parseIdx !== -1 ? parseIdx : progIdx
    newCli = cliRaw.slice(0, insertBefore) + replacement + cliRaw.slice(insertBefore)
  }
}

if (newCli === cliRaw) {
  console.log('No changes made to cli.ts (replacement matched existing content)')
  process.exit(0)
}

// Backup original
// await writeFile(cliPath + '.bak', cliRaw, 'utf8')
await writeFile(cliPath, newCli, 'utf8')
console.log('cli.ts updated with package.json metadata and backup created at cli.ts.bak')
