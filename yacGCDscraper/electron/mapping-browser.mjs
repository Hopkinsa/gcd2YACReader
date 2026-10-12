import { canonicalGcdCandidates } from './gcd-match-dedup.mjs'
import { extractPathMetadata } from './path-metadata.mjs'
import { saveGcdProposal } from './gcd-sync.mjs'

function issueNumber(value) {
  const match = String(value ?? '').trim().match(/^(\d+)(?:\.(\d+))?$/)
  return match ? `${Number(match[1])}${match[2] === undefined ? '' : `.${match[2]}`}` : ''
}

export function browseGcdRecords(database, { publisherId, seriesId, search = '', page = 1 } = {}) {
  const pageSize = 100
  const currentPage = Math.max(1, Number.isSafeInteger(page) ? page : 1)
  const searchText = String(search).trim()
  const term = `%${searchText.replace(/[\\%_]/g, '\\$&')}%`
  let rows
  let level
  if (seriesId !== undefined) {
    if (!Number.isSafeInteger(seriesId) || seriesId <= 0) throw new Error('Select a valid GCD series.')
    level = 'issues'
    rows = database.prepare(`SELECT i.id, i.number, i.title, i.variant_of_id AS variantOfId, i.variant_name AS variantName,
      s.id AS seriesId, s.name AS seriesName, p.name AS publisherName, ip.name AS indiciaPublisher,
      i.on_sale_date AS onSaleDate
      FROM gcd_issue i JOIN gcd_series s ON s.id = i.series_id
      LEFT JOIN gcd_publisher p ON p.id = s.publisher_id
      LEFT JOIN gcd_indicia_publisher ip ON ip.id = i.indicia_publisher_id
      WHERE i.series_id = ? AND +i.deleted = 0 AND +s.deleted = 0
        AND (i.number LIKE ? ESCAPE '\\' OR i.title LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')
      ORDER BY i.sort_code, i.id LIMIT ? OFFSET ?`).all(seriesId, term, term, term, term, pageSize + 1, (currentPage - 1) * pageSize)
  } else if (publisherId !== undefined) {
    if (!Number.isSafeInteger(publisherId) || publisherId <= 0) throw new Error('Select a valid GCD publisher.')
    level = 'series'
    rows = database.prepare(`SELECT s.id, s.name, s.year_began AS yearBegan,
      (SELECT COUNT(DISTINCT COALESCE(NULLIF(i.variant_of_id, 0), i.id)) FROM gcd_issue i
        WHERE i.series_id = s.id AND +i.deleted = 0) AS issueCount
      FROM gcd_series s
      LEFT JOIN gcd_publisher p ON p.id = s.publisher_id
      WHERE s.publisher_id = ? AND +s.deleted = 0 AND (s.name LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM gcd_issue i WHERE i.series_id = s.id AND +i.deleted = 0 AND i.title LIKE ? ESCAPE '\\'))
      ORDER BY s.name COLLATE NOCASE, s.year_began, s.id LIMIT ? OFFSET ?`).all(publisherId, term, term, term, pageSize + 1, (currentPage - 1) * pageSize)
  } else {
    level = 'publishers'
    rows = database.prepare(`SELECT p.id, p.name FROM gcd_publisher p WHERE +p.deleted = 0
      AND (? = '' OR p.name LIKE ? ESCAPE '\\' OR p.id IN (
        SELECT s.publisher_id FROM gcd_series s WHERE +s.deleted = 0 AND s.name LIKE ? ESCAPE '\\'
        UNION
        SELECT s.publisher_id FROM gcd_issue i CROSS JOIN gcd_series s ON s.id = i.series_id
          WHERE +i.deleted = 0 AND +s.deleted = 0 AND i.title LIKE ? ESCAPE '\\'))
      ORDER BY p.name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`).all(searchText, term, term, term, pageSize + 1, (currentPage - 1) * pageSize)
  }
  return { level, records: rows.slice(0, pageSize), page: currentPage, hasMore: rows.length > pageSize }
}

export async function createGcdMappings({ library, gcd, enrichment, comicId, gcdIssueId, matchFolder = false, overwriteExisting = false, resolveFields }) {
  if (!Number.isSafeInteger(comicId) || comicId <= 0 || !Number.isSafeInteger(gcdIssueId) || gcdIssueId <= 0) throw new Error('Select a library comic and a GCD issue.')
  const anchor = library.prepare(`SELECT ci.*, c.id AS comicId, c.parentId AS folderId, c.comicInfoId, c.fileName, c.path
    FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId WHERE c.id = ?`).get(comicId)
  const issue = gcd.prepare(`SELECT i.id, i.series_id AS seriesId FROM gcd_issue i
    JOIN gcd_series s ON s.id = i.series_id WHERE i.id = ? AND +i.deleted = 0 AND +s.deleted = 0`).get(gcdIssueId)
  if (!anchor || !issue) throw new Error('The selected comic or GCD issue is unavailable.')
  const stored = (comicInfoId) => JSON.parse(enrichment.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = ?').get(comicInfoId)?.fields_json || '{}')
  if (matchFolder && String(stored(anchor.comicInfoId).gcdIssueId || '') !== String(gcdIssueId)) throw new Error('Save the selected mapping before mapping the remaining folder.')
  const comics = matchFolder
    ? library.prepare(`SELECT ci.*, c.comicInfoId, c.fileName, c.path FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId
      WHERE c.parentId = ? AND c.comicInfoId != ? GROUP BY ci.id ORDER BY c.id`).all(anchor.folderId, anchor.comicInfoId)
    : [anchor]
  const candidates = new Map()
  if (matchFolder) {
    const issues = gcd.prepare(`SELECT id, number, variant_of_id AS variantOfId FROM gcd_issue
      WHERE series_id = ? AND +deleted = 0 ORDER BY sort_code, id`).all(issue.seriesId)
    for (const candidate of issues) {
      const number = issueNumber(candidate.number)
      if (!number) continue
      const group = candidates.get(number) || []
      group.push({ ...candidate, score: 100 })
      candidates.set(number, group)
    }
  }
  const result = { scanned: comics.length, saved: 0, skippedExisting: 0, ambiguous: 0, unmatched: 0, failed: 0 }
  const proposals = []
  for (const comic of comics) {
    const existing = stored(comic.comicInfoId)
    if (existing.gcdIssueId && overwriteExisting !== true) {
      if (!matchFolder && String(existing.gcdIssueId) !== String(gcdIssueId)) throw new Error('This comic already has a mapping. Enable Replace existing mappings to change it.')
      if (matchFolder) { result.skippedExisting += 1; continue }
    }
    let selectedId = gcdIssueId
    if (matchFolder) {
      const number = issueNumber(comic.number || extractPathMetadata(comic).number)
      const matches = canonicalGcdCandidates(candidates.get(number) || [])
      if (!matches.length) { result.unmatched += 1; continue }
      if (matches.length !== 1) { result.ambiguous += 1; continue }
      selectedId = matches[0].id
    }
    try {
      const fields = await resolveFields(selectedId)
      if (!fields || String(fields.gcdIssueId) !== String(selectedId)) throw new Error('The selected GCD issue could not be loaded.')
      const merged = matchFolder && overwriteExisting !== true ? { ...fields, ...Object.fromEntries(Object.entries(existing).filter(([, value]) => String(value ?? '').trim())), gcdIssueId: String(selectedId) } : fields
      proposals.push({ comicInfoId: comic.comicInfoId, fields: merged, previous: existing.gcdIssueId })
    } catch (error) {
      if (!matchFolder) throw error
      result.failed += 1
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  enrichment.transaction(() => {
    for (const proposal of proposals) {
      if (String(stored(proposal.comicInfoId).gcdIssueId || '') !== String(proposal.previous || '')) throw new Error('A mapping changed during this operation. Reload and try again.')
      saveGcdProposal(enrichment, proposal.comicInfoId, proposal.fields)
    }
  })()
  return { ...result, saved: proposals.length }
}