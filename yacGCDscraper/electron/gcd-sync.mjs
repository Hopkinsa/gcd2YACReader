function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function combinedValues(values, separator = '; ', split = false) {
  return [...new Set(values.flatMap((value) => split ? String(value ?? '').split(';') : [String(value ?? '')])
    .map((value) => value.trim()).filter(Boolean))].join(separator)
}

export function normalizeGcdDate(value) {
  const text = String(value ?? '').replaceAll('[', '').replaceAll(']', '').trim()
  if (/^\d{4}$/.test(text)) return `30/06/${text}`
  const yearFirst = text.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]00)?$/)
  const monthFirst = text.match(/^(\d{1,2})[-/.](\d{4})$/)
  const namedMonth = text.match(/^([a-z]+)\.?[\s,/-]+(\d{4})$/i)
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const month = yearFirst ? Number(yearFirst[2]) : monthFirst ? Number(monthFirst[1]) : namedMonth ? months.findIndex((name) => name === namedMonth[1].toLowerCase() || name.slice(0, 3) === namedMonth[1].toLowerCase() || (name === 'september' && namedMonth[1].toLowerCase() === 'sept')) + 1 : 0
  const year = yearFirst?.[1] || monthFirst?.[2] || namedMonth?.[2]
  if (year && month >= 1 && month <= 12) return `01/${String(month).padStart(2, '0')}/${year}`
  if (yearFirst && month === 0) return `30/06/${yearFirst[1]}`
  return text
}

export const yacReaderMappings = {
  title: 'title', series: 'series', issueNumber: 'number', issueCount: 'count', volume: 'volume',
  onSaleDate: 'date', publisher: 'publisher', imprint: 'imprint', editor: 'editor', coverArtist: 'coverArtist',
  storyGenre: 'genere', storyCharacters: 'characters', storySynopsis: 'synopsis', storyNotes: 'notes',
  crossoverArc: 'storyArc', crossoverPart: 'arcNumber', arcCount: 'arcCount',
  script: 'writer', pencils: 'penciller', inks: 'inker', colors: 'colorist', letters: 'letterer',
  alternateSeries: 'alternateSeries', alternateNumber: 'alternateNumber', alternateCount: 'alternateCount',
  seriesGroup: 'seriesGroup', teams: 'teams', locations: 'locations', mainCharacterOrTeam: 'mainCharacterOrTeam',
  format: 'format', ageRating: 'ageRating', languageISO: 'languageISO', review: 'review', tags: 'tags',
}

const metadataDatabaseCache = new WeakMap()

export function extractGcdFields(database, match) {
  let cache = metadataDatabaseCache.get(database)
  if (!cache) {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    cache = { tables, columns: new Map(), statements: new Map() }
    metadataDatabaseCache.set(database, cache)
  }
  const supports = (...tables) => tables.every((table) => cache.tables.has(table))
  const hasColumn = (table, column) => {
    if (!cache.columns.has(table)) cache.columns.set(table, new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name)))
    return cache.columns.get(table).has(column)
  }
  const rows = (sql, ...parameters) => {
    if (!cache.statements.has(sql)) cache.statements.set(sql, database.prepare(sql))
    return cache.statements.get(sql).all(...parameters)
  }
  const enriched = { ...match, stories: (match.stories || []).map((story) => ({ ...story })) }
  const issue = rows('SELECT series_id AS seriesId FROM gcd_issue WHERE id = ?', match.id)[0]
  if (issue && hasColumn('gcd_series', 'issue_count')) {
    enriched.issueCount = rows('SELECT issue_count AS count FROM gcd_series WHERE id = ?', issue.seriesId)[0]?.count
  }
  if (issue && !hasValue(enriched.seriesFormat) && hasColumn('gcd_series', 'publishing_format')) {
    enriched.seriesFormat = rows('SELECT publishing_format AS format FROM gcd_series WHERE id = ?', issue.seriesId)[0]?.format
  }
  if (issue && supports('stddata_language') && hasColumn('gcd_series', 'language_id')) {
    enriched.languageISO = rows(`SELECT l.code FROM gcd_series s JOIN stddata_language l ON l.id = s.language_id WHERE s.id = ?`, issue.seriesId)[0]?.code
  }
  if (supports('gcd_story_credit', 'gcd_credit_type', 'gcd_creator_name_detail')) {
    const credits = rows(`SELECT c.story_id AS storyId, t.name AS type,
      COALESCE(NULLIF(c.credit_name, ''), n.name) AS name
      FROM gcd_story s CROSS JOIN gcd_story_credit c ON c.story_id = s.id
      JOIN gcd_credit_type t ON t.id = c.credit_type_id
      LEFT JOIN gcd_creator_name_detail n ON n.id = c.creator_id AND n.deleted = 0
      WHERE s.issue_id = ? AND +s.deleted = 0 AND +c.deleted = 0 ORDER BY c.id`, match.id)
    for (const story of enriched.stories) {
      for (const field of ['script', 'pencils', 'inks', 'colors', 'letters', 'editing']) {
        const names = credits.filter((credit) => credit.storyId === story.id &&
          (credit.type.split(/,\s*|\s+and\s+/).includes(field) || (credit.type === 'painting' && ['pencils', 'inks', 'colors'].includes(field))))
          .map((credit) => credit.name)
        story[field] = combinedValues([story[field], ...names], '; ', true)
      }
    }
  }
  if (supports('gcd_story_arc', 'gcd_story_story_arc')) {
    const arcs = rows(`SELECT DISTINCT a.id, a.name FROM gcd_story s
      CROSS JOIN gcd_story_story_arc link ON link.story_id = s.id CROSS JOIN gcd_story_arc a ON a.id = link.storyarc_id
      WHERE s.issue_id = ? AND +s.deleted = 0 AND +a.deleted = 0 ORDER BY a.id`, match.id)
    enriched.crossoverArc = combinedValues(arcs.map((arc) => arc.name))
    if (arcs.length === 1 && hasColumn('gcd_issue', 'sort_code')) {
      const arcIssues = rows(`SELECT DISTINCT i.id, i.key_date, i.series_id, i.sort_code FROM gcd_story_story_arc link
        CROSS JOIN gcd_story s ON s.id = link.story_id CROSS JOIN gcd_issue i ON i.id = s.issue_id
        WHERE link.storyarc_id = ? AND +s.deleted = 0 AND +i.deleted = 0 AND i.variant_of_id IS NULL
        ORDER BY i.key_date, i.series_id, i.sort_code, i.id`, arcs[0].id)
      const position = arcIssues.findIndex((entry) => entry.id === (match.variantOfId || match.id))
      if (position >= 0) {
        enriched.crossoverPart = String(position + 1)
        enriched.arcCount = String(arcIssues.length)
      }
    }
  }
  if (supports('gcd_story_character', 'gcd_character', 'gcd_character_role')) {
    const characters = rows(`SELECT sc.id, sc.story_id AS storyId, c.name, r.name AS role
      FROM gcd_story s CROSS JOIN gcd_story_character sc ON sc.story_id = s.id CROSS JOIN gcd_character c ON c.id = sc.character_id
      LEFT JOIN gcd_character_role r ON r.id = sc.role_id
      WHERE s.issue_id = ? AND +s.deleted = 0 AND +sc.deleted = 0 AND +c.deleted = 0 ORDER BY sc.id`, match.id)
    for (const story of enriched.stories) story.characters = combinedValues([story.characters,
      ...characters.filter((character) => character.storyId === story.id).map((character) => character.name)], '; ', true)
    enriched.mainCharacterOrTeam = combinedValues(characters.filter((character) => character.role === 'featured').map((character) => character.name))
    if (supports('gcd_story_character_group', 'gcd_group')) {
      const groups = rows(`SELECT g.name, r.name AS role FROM gcd_story s
        CROSS JOIN gcd_story_character sc ON sc.story_id = s.id
        CROSS JOIN gcd_story_character_group link ON link.storycharacter_id = sc.id
        CROSS JOIN gcd_group g ON g.id = link.group_id LEFT JOIN gcd_character_role r ON r.id = sc.role_id
        WHERE s.issue_id = ? AND +s.deleted = 0 AND +sc.deleted = 0 AND +g.deleted = 0 ORDER BY link.id`, match.id)
      enriched.teams = combinedValues(groups.map((group) => group.name))
      enriched.mainCharacterOrTeam = combinedValues([enriched.mainCharacterOrTeam,
        ...groups.filter((group) => group.role === 'featured').map((group) => group.name)], '; ', true)
    }
  }
  if (supports('taggit_tag', 'taggit_taggeditem', 'django_content_type')) {
    const tags = rows(`SELECT t.name FROM taggit_taggeditem item JOIN taggit_tag t ON t.id = item.tag_id
      JOIN django_content_type ct ON ct.id = item.content_type_id
      WHERE ct.app_label = 'gcd' AND ((ct.model = 'issue' AND item.object_id = ?)
        OR (ct.model = 'series' AND item.object_id = ?)
        OR (ct.model = 'story' AND item.object_id IN (SELECT id FROM gcd_story WHERE issue_id = ? AND +deleted = 0)))
      ORDER BY t.name, t.id`, match.id, issue?.seriesId ?? null, match.id)
    enriched.tags = combinedValues(tags.map((tag) => tag.name))
  }
  return fieldsFromMatch(enriched)
}

export function fieldsFromMatch(match) {
  const stories = match.stories || []
  const primaryStory = stories.find((story) => story.type === 'comic story') || stories[0]
  const storyValues = (field, split = true) => combinedValues(stories.map((story) => story[field]), split ? '; ' : '\n\n', split)
  const issueNumber = String(match.number ?? '').trim().match(/^(\d+)(?:\.(\d+))?$/)
  return {
    title: match.title || match.seriesName || '', series: match.seriesName || '',
    issueNumber: issueNumber ? `${Number(issueNumber[1])}${issueNumber[2] === undefined ? '' : `.${issueNumber[2]}`}` : '',
    volume: match.volume || '', issueCount: match.issueCount > 0 ? String(match.issueCount) : '',
    issueTitle: match.title || '', variantName: match.variantName || '',
    publicationDate: match.publicationDate || '', keyDate: match.keyDate || '', price: match.price || '',
    pageCount: String(match.pageCount || ''),
    editor: combinedValues([match.editing, ...stories.map((story) => story.editing)]
      .map((value) => String(value || '').replace(/\s*\(editor\)/gi, '')), '; ', true),
    onSaleDate: normalizeGcdDate(match.onSaleDate || match.publicationDate),
    publisher: match.indiciaPublisher || match.publisherName || '',
    imprint: match.publisherName || match.indiciaPublisher || '',
    publisherBrand: match.publisherBrand || '', indiciaPublisher: match.indiciaPublisher || '',
    isbn: match.isbn || '', barcode: match.barcode || '', rating: match.rating || '',
    ageRating: match.rating || '', format: match.seriesFormat || '', languageISO: match.languageISO || '',
    indiciaFrequency: match.indiciaFrequency || '', issueNotes: match.issueNotes || '',
    storyId: String(primaryStory?.id || ''), storyType: primaryStory?.type || '',
    storyName: primaryStory?.title || (primaryStory?.type === 'comic story' ? primaryStory.feature : '') || '',
    storyFeature: storyValues('feature'), storyPart: String(primaryStory?.sequenceNumber ?? ''),
    storyPageCount: String(primaryStory?.pageCount || ''),
    script: storyValues('script'), pencils: storyValues('pencils'), inks: storyValues('inks'),
    colors: storyValues('colors'), letters: storyValues('letters'), storyEditor: storyValues('editing'),
    coverArtist: combinedValues(stories.filter((story) => story.type === 'cover')
      .flatMap((story) => [story.pencils, story.inks]), '; ', true),
    storyGenre: storyValues('genre'), storyCharacters: storyValues('characters', false),
    storySynopsis: storyValues('synopsis', false),
    storyNotes: combinedValues([match.issueNotes, ...stories.map((story) => story.notes)], '\n\n'),
    firstLine: storyValues('firstLine', false),
    crossoverArc: match.crossoverArc || '', crossoverPart: match.crossoverPart || '', arcCount: match.arcCount || '',
    teams: match.teams || '', locations: match.locations || '', mainCharacterOrTeam: match.mainCharacterOrTeam || '',
    alternateSeries: match.alternateSeries || '', alternateNumber: match.alternateNumber || '', alternateCount: match.alternateCount || '',
    seriesGroup: match.seriesGroup || '', review: match.review || '', tags: match.tags || '',
    gcdIssueId: String(match.id), stories: JSON.stringify(stories),
  }
}

export function resolveGcdSyncCandidate(savedIssueId, { findById, findCandidates }) {
  if (hasValue(savedIssueId)) {
    const issueId = Number(savedIssueId)
    return /^\d+$/.test(String(savedIssueId)) && Number.isSafeInteger(issueId) && issueId > 0 ? findById(issueId) || null : null
  }
  const matches = findCandidates().filter((match) => match.score === 100)
  return matches.length === 1 ? matches[0] : null
}

export function gcdSyncChanges(plan, replaceExisting = false) {
  return replaceExisting === true ? [...plan.missingChanges, ...plan.differingChanges] : plan.missingChanges
}

export function saveGcdProposal(database, comicInfoId, fields) {
  const existingFields = JSON.parse(database.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = ?').get(comicInfoId)?.fields_json || '{}')
  const savedFields = { ...fields }
  if (!hasValue(savedFields.gcdIssueId) && hasValue(existingFields.gcdIssueId)) savedFields.gcdIssueId = existingFields.gcdIssueId
  database.prepare('INSERT INTO enrichment (comic_info_id, fields_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(comic_info_id) DO UPDATE SET fields_json = excluded.fields_json, updated_at = excluded.updated_at').run(comicInfoId, JSON.stringify(savedFields))
}

export function persistGcdLinks(database, links) {
  const find = database.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = ?')
  const save = database.prepare('INSERT INTO enrichment (comic_info_id, fields_json) VALUES (?, ?) ON CONFLICT(comic_info_id) DO UPDATE SET fields_json = excluded.fields_json, updated_at = CURRENT_TIMESTAMP')
  return database.transaction(() => {
    let savedLinks = 0
    for (const { comicInfoId, gcdIssueId } of links) {
      const issueId = Number(gcdIssueId)
      if (!Number.isSafeInteger(comicInfoId) || comicInfoId <= 0 || !/^\d+$/.test(String(gcdIssueId)) || !Number.isSafeInteger(issueId) || issueId <= 0) throw new Error('Invalid GCD link.')
      const fields = JSON.parse(find.get(comicInfoId)?.fields_json || '{}')
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid stored GCD proposal.')
      if (hasValue(fields.gcdIssueId)) {
        if (String(fields.gcdIssueId) !== String(gcdIssueId)) throw new Error('GCD link changed during the scan. Generate a new sync preview.')
        continue
      }
      save.run(comicInfoId, JSON.stringify({ ...fields, gcdIssueId: String(gcdIssueId) }))
      savedLinks += 1
    }
    return savedLinks
  })()
}

export async function buildGcdSyncPlan({ comics, resolveFields, mappings, columns, onProgress = () => {} }) {
  const plan = { scanned: 0, matched: 0, unmatched: 0, failed: 0, skippedUnsupported: 0, matchedLinks: [], missingChanges: [], differingChanges: [] }
  onProgress({ scanned: 0, total: comics.length, matched: 0, unmatched: 0, failed: 0 })
  for (const comic of comics) {
    let fields
    try {
      fields = await resolveFields(comic)
    } catch {
      plan.failed += 1
    }
    if (fields) {
      plan.matched += 1
      if (hasValue(fields.gcdIssueId)) plan.matchedLinks.push({ comicInfoId: comic.comicInfoId, gcdIssueId: fields.gcdIssueId })
      for (const [enrichmentField, libraryField] of Object.entries(mappings)) {
        const value = fields[enrichmentField]
        if (!hasValue(value)) continue
        if (!columns.has(libraryField)) {
          plan.skippedUnsupported += 1
          continue
        }
        const previousValue = comic[libraryField] ?? null
        if (String(previousValue ?? '') === String(value)) continue
        const change = { comicInfoId: comic.comicInfoId, fileName: comic.fileName, enrichmentField, libraryField, previousValue, value: String(value) }
        if (hasValue(previousValue)) plan.differingChanges.push(change)
        else plan.missingChanges.push(change)
      }
    } else {
      plan.unmatched += 1
    }
    plan.scanned += 1
    if (plan.scanned === comics.length || plan.scanned % 10 === 0) {
      onProgress({ scanned: plan.scanned, total: comics.length, matched: plan.matched, unmatched: plan.unmatched, failed: plan.failed })
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return plan
}

export function applyGcdSyncChanges(database, changes, mappings) {
  const allowedColumns = new Set(Object.values(mappings))
  const columns = new Set(database.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
  const timestamp = Math.floor(Date.now() / 1000)
  return database.transaction(() => {
    let updatedFields = 0
    for (const change of changes) {
      if (!allowedColumns.has(change.libraryField) || !columns.has(change.libraryField)) throw new Error('Unsupported sync field.')
      const timestampClause = columns.has('lastTimeMetadataSet') ? ', lastTimeMetadataSet = ?' : ''
      const result = database.prepare(`UPDATE comic_info SET ${change.libraryField} = ?${timestampClause} WHERE id = ? AND ${change.libraryField} IS ?`)
        .run(change.value, ...(timestampClause ? [timestamp] : []), change.comicInfoId, change.previousValue)
      if (result.changes !== 1) throw new Error('Library metadata changed since the preview. Generate a new GCD sync preview before applying updates.')
      updatedFields += result.changes
    }
    return updatedFields
  })()
}