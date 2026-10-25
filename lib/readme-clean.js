/**
 * Strip README presentation and boilerplate that do not describe what the
 * plugin does: badges, images, HTML, code, front matter, link-only lines, and
 * license/install/contributing/changelog sections. The remaining text is then
 * token-truncated by the model client.
 */

export const README_CLEAN_VERSION = 1

const DROP_SECTIONS = new Set([
  'license',
  'licence',
  'licensing',
  'contributing',
  'contribution',
  'code of conduct',
  'security',
  'changelog',
  'release notes',
  'releases',
  'table of contents',
  'contents',
  'installation',
  'install',
  'getting started',
  'setup',
  'development',
  'developing',
  'testing',
  'tests',
  'sponsors',
  'sponsor',
  'support',
  'acknowledgements',
  'acknowledgments',
  'credits',
  'authors',
  'star history',
  'changelog and versioning',
])

function normalizeHeading(value) {
  return value
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isDropHeading(value) {
  return DROP_SECTIONS.has(normalizeHeading(value))
}

function stripBoilerplateSections(text) {
  const lines = text.split('\n')
  const kept = []
  let skipLevel = 0
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      if (skipLevel && level <= skipLevel) skipLevel = 0
      if (!skipLevel && isDropHeading(heading[2])) {
        skipLevel = level
        continue
      }
    }
    if (skipLevel) continue
    kept.push(line)
  }
  return kept.join('\n')
}

function stripBadges(text) {
  return text
    // Markdown image, including the common linked-badge form.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    // Reference-style link definitions.
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '')
    // Remaining markdown links keep only their label.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
}

export function cleanReadmeText(input) {
  let text = String(input ?? '').replace(/\r\n?/g, '\n')
  // YAML front matter.
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  // HTML comments.
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  // Fenced code and indented code blocks.
  text = text.replace(/```[\s\S]*?```/g, '\n')
  text = text.replace(/~~~[\s\S]*?~~~/g, '\n')
  text = text.replace(/^(?: {4}|\t).*$/gm, '')
  // HTML tags; keep line breaks.
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<[^>]*>/g, '')
  // Badges, images, and link labels.
  text = stripBadges(text)
  // Drop badges/shields and link-only lines that survived as plain URLs.
  text = text.split('\n').filter(line => {
    if (/shields\.io|badgen|img\.shields|badge/i.test(line) && !/[.!?]/.test(line)) return false
    const withoutUrls = line.replace(/https?:\/\/\S+/gi, '').replace(/[\s\-|:]/g, '')
    return withoutUrls !== ''
  }).join('\n')
  // Drop boilerplate sections before removing heading markers.
  text = stripBoilerplateSections(text)
  // Heading/list/blockquote markers, keeping the text.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
  // Table separators, pipes, emphasis, inline code markup.
  text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/gm, '')
  text = text.replace(/\|/g, ' ')
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/[*_]{1,2}/g, '')
  text = text.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ')
  // Horizontal rules and empty/punctuation-only lines.
  text = text.split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line !== '' && !/^[-=*_]{3,}$/.test(line) && /[\p{L}\p{N}]/u.test(line))
    .join('\n')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}
