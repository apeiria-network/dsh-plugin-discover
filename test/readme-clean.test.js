import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanReadmeText, README_CLEAN_VERSION } from '../lib/readme-clean.js'

test('README cleaner removes badges, images, HTML, links, and code', () => {
  const input = [
    '---',
    'title: demo',
    '---',
    '# Demo Plugin',
    '[![npm](https://img.shields.io/npm/v/demo.svg)](https://npmjs.com/package/demo)',
    '![screenshot](https://example.com/shot.png)',
    '<p align="center"><img src="https://example.com/logo.png"></p>',
    'This plugin **captures screenshots** and [reads text](https://example.com/docs).',
    '```bash',
    'npm install demo',
    '```',
    '## Features',
    '- Captures a window',
    '- Extracts text',
    '## Installation',
    'npm install demo',
    '## License',
    'MIT',
  ].join('\n')
  const clean = cleanReadmeText(input)
  assert.match(clean, /Demo Plugin/)
  assert.match(clean, /captures screenshots/)
  assert.match(clean, /reads text/)
  assert.match(clean, /Features/)
  assert.match(clean, /Captures a window/)
  assert.doesNotMatch(clean, /shields\.io/)
  assert.doesNotMatch(clean, /screenshot\.png/)
  assert.doesNotMatch(clean, /<p/)
  assert.doesNotMatch(clean, /npm install demo/)
  assert.doesNotMatch(clean, /MIT/)
  assert.ok(clean.length > 20)
})

test('README cleaner keeps prose while dropping boilerplate sections', () => {
  const input = [
    '# Tool',
    'A tool that watches files and reports changes.',
    '',
    '## Usage',
    'Run it in a project.',
    '',
    '## Contributing',
    'See CONTRIBUTING.md.',
    '### Development',
    'Run tests.',
    '',
    '## Changelog',
    'v1.0.0',
    '',
    '## Security',
    'Report privately.',
  ].join('\n')
  const clean = cleanReadmeText(input)
  assert.match(clean, /watches files/)
  assert.match(clean, /Run it in a project/)
  assert.doesNotMatch(clean, /CONTRIBUTING/)
  assert.doesNotMatch(clean, /Run tests/)
  assert.doesNotMatch(clean, /v1\.0\.0/)
  assert.doesNotMatch(clean, /Report privately/)
})

test('README cleaner keeps link labels but removes link-only lines', () => {
  const input = [
    '# Plugin',
    '[Documentation](https://example.com/docs)',
    '[Source](https://github.com/acme/plugin)',
    'A useful plugin.',
    'https://example.com/badge',
  ].join('\n')
  const clean = cleanReadmeText(input)
  assert.match(clean, /Documentation/)
  assert.match(clean, /Source/)
  assert.match(clean, /A useful plugin/)
  assert.doesNotMatch(clean, /https:\/\//)
})

test('README cleaner returns empty for content that is only presentation', () => {
  assert.equal(cleanReadmeText('![badge](https://img.shields.io/x)'), '')
  assert.equal(cleanReadmeText('<img src="x">'), '')
  assert.equal(cleanReadmeText('---\ntitle: x\n---'), '')
  assert.equal(cleanReadmeText(''), '')
})

test('README clean version is nonzero so old caches can be invalidated', () => {
  assert.ok(Number.isInteger(README_CLEAN_VERSION) && README_CLEAN_VERSION > 0)
})
