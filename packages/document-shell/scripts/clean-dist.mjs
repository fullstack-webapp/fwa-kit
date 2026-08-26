import { rm } from 'node:fs/promises'
import path from 'node:path'

const packageRoot = path.resolve(import.meta.dirname, '..')
const dist = path.join(packageRoot, 'dist')

await rm(dist, { recursive: true, force: true })
console.log(`[document-shell] cleaned ${path.relative(packageRoot, dist)}`)
