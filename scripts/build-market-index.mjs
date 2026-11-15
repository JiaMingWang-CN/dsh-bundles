#!/usr/bin/env node
// Regenerate the DSH plugin-market format-1 index from the npm registry.
// Run after publishing; the GitHub workflow runs it on every push to main
// and deploys _site to GitHub Pages.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'https://github.com/JiaMingWang-CN/dsh-bundles'
const REGISTRY = 'https://registry.npmjs.org'
const FALLBACK_DSH = '^0.1.7-rc.2 || ^0.2.0-rc.2 || ^0.2.1-alpha.2 || ^0.2.2-rc.1'
const OUT = '_site'
const STUB_VERSION = '0.0.0-stage'

const display = JSON.parse(readFileSync('market/display.json', 'utf8'))

const bundles = readdirSync('.', { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(entry.name, 'package.json')))
  .map((entry) => ({
    dir: entry.name,
    pkg: JSON.parse(readFileSync(join(entry.name, 'package.json'), 'utf8')),
  }))
  .filter(({ pkg }) => pkg.dsh?.bundle)

async function registryDoc(name) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`)
  if (!response.ok) throw new Error(`${name}: registry answered ${response.status}`)
  return response.json()
}

const plugins = []
for (const { dir, pkg } of bundles) {
  const meta = display[dir]
  if (!meta) throw new Error(`market/display.json has no entry for ${dir}`)
  const doc = await registryDoc(pkg.name)
  const versions = Object.values(doc.versions)
    .filter((version) => version.stub !== true && version.version !== STUB_VERSION)
    .map((version) => ({
      version: version.version,
      publishTimestamp: Math.floor(Date.parse(doc.time[version.version]) / 1000),
      source: { type: 'npm' },
      engines: { dsh: version.engines?.dsh ?? FALLBACK_DSH },
    }))
  if (versions.length === 0) throw new Error(`${pkg.name}: no published version yet`)

  const plugin = {
    name: pkg.name,
    title: meta.title,
    description: meta.description,
    author: meta.author ?? pkg.author,
    homepage: `${REPO}#readme`,
    repository: { url: REPO, directory: dir },
    metadata: { category: meta.category, keywords: meta.keywords },
    versions,
  }
  if (meta.icon) {
    mkdirSync(join(OUT, dir), { recursive: true })
    copyFileSync(join(dir, meta.icon), join(OUT, dir, meta.icon))
    plugin.icon = `${dir}/${meta.icon}`
  }
  plugins.push(plugin)
}

const index = {
  format: 1,
  title: { en: 'dsh-bundles', zh: 'dsh-bundles' },
  description: {
    en: 'DeepSeek Harness plugins by JiaMingWang-CN, published on npm.',
    zh: 'JiaMingWang-CN 的 DeepSeek Harness 插件，通过 npm 发布。',
  },
  metadata: {
    categories: {
      ui: { title: { en: 'Web UI', zh: '界面' } },
      tools: { title: { en: 'Tools', zh: '工具' } },
      memory: { title: { en: 'Memory', zh: '记忆' } },
      search: { title: { en: 'Search', zh: '搜索' } },
    },
  },
  plugins,
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${OUT}/index.json with ${plugins.length} plugins`)
