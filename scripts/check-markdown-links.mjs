import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'target',
  'out',
  'dist',
  'release',
  'test-results',
  'playwright-report'
])

async function markdownFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await markdownFiles(join(directory, entry.name)))
      continue
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(join(directory, entry.name))
  }
  return files
}

const missing = []
const files = await markdownFiles(repositoryRoot)
for (const file of files) {
  const markdown = await readFile(file, 'utf8')
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:|#)/i.test(rawTarget)) continue
    const target = decodeURIComponent(rawTarget.split('#', 1)[0])
    if (!target) continue
    const absoluteTarget = resolve(dirname(file), target)
    try {
      await access(absoluteTarget)
    } catch {
      missing.push(`${file.slice(repositoryRoot.length + 1)} -> ${rawTarget}`)
    }
  }
}

if (missing.length > 0) {
  console.error(`Broken local Markdown links:\n${missing.map((item) => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Checked local links in ${files.length} Markdown files.`)
}
