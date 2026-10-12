import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import Database from 'better-sqlite3'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalGcdCandidates } from './gcd-match-dedup.mjs'
import { extractPathMetadata } from './path-metadata.mjs'
import { browseGcdRecords, createGcdMappings } from './mapping-browser.mjs'
import { applyGcdSyncChanges, buildGcdSyncPlan, extractGcdFields, fieldsFromMatch, gcdSyncChanges, listGcdProposals, normalizeGcdDate, persistGcdLinks, removeGcdProposals, resolveGcdSyncCandidate, saveGcdProposal, yacReaderMappings } from './gcd-sync.mjs'

const appDirectory = path.dirname(fileURLToPath(import.meta.url))
const developmentLibraryPath = path.resolve(appDirectory, '../../yac_data/library.ydb')
const developmentGcdPath = path.resolve(appDirectory, '../../gcd_data/sqlite2026-09-01.db')
const libraryPath = process.env.YAC_GCD_LIBRARY_PATH || developmentLibraryPath
const gcdPath = process.env.YAC_GCD_DATABASE_PATH || developmentGcdPath
const coversPath = process.env.YAC_GCD_COVERS_PATH || path.join(path.dirname(libraryPath), 'covers')
const libraryRootFolderId = 1
const allComicsFolderId = 0
const defaultPageSize = 120
const gcdStoryStatementCache = new WeakMap()
const pendingGcdSyncPlans = new Map()
const gcdSyncBusy = new Set()
const editableComicInfoFields = new Set([
  'series', 'title', 'number', 'count', 'volume', 'storyArc', 'arcNumber', 'arcCount',
  'alternateSeries', 'alternateNumber', 'alternateCount', 'seriesGroup', 'genere',
  'synopsis', 'characters', 'teams', 'locations', 'mainCharacterOrTeam', 'writer',
  'penciller', 'inker', 'colorist', 'letterer', 'coverArtist', 'editor', 'imprint',
  'date', 'publisher', 'format', 'color', 'ageRating', 'type', 'languageISO', 'review',
  'notes', 'tags',
])

function openLibrary() {
  if (!existsSync(libraryPath)) throw new Error(`YACReader database not found at ${libraryPath}. Set YAC_GCD_LIBRARY_PATH to choose another library.`)
  return new Database(libraryPath, { readonly: true, fileMustExist: true })
}

function coverUrl(hash) {
  if (!/^[a-f0-9]{16,128}$/i.test(hash || '')) return null
  const coverPath = path.join(coversPath, `${hash}.jpg`)
  return existsSync(coverPath) ? `yac-cover://${hash}` : null
}

function enrichmentDatabase() {
  const database = new Database(path.join(app.getPath('userData'), 'enrichment.db'))
  database.exec(`CREATE TABLE IF NOT EXISTS enrichment (
    comic_info_id INTEGER PRIMARY KEY,
    fields_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  return database
}

function normalize(value) {
  return (value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '')
}

function normalizeNumber(value) {
  const compact = (value || '').trim().replace(/\s+/g, '')
  const numericPrefix = compact.match(/^0*(\d+)(.*)$/)
  if (!numericPrefix) return compact.toLocaleLowerCase()
  return `${Number(numericPrefix[1])}${numericPrefix[2].toLocaleLowerCase()}`
}

function normalizeIssueNumber(value) {
  const compact = String(value || '').trim()
  const numericIssue = compact.match(/^(\d+)(?:\.(\d+))?$/)
  if (!numericIssue) return ''
  return numericIssue[2] === undefined ? String(Number(numericIssue[1])) : `${Number(numericIssue[1])}.${numericIssue[2]}`
}

function hasWildcard(value) {
  return /[*?]/.test(String(value || ''))
}

function normalizedWildcardPattern(value) {
  return [...String(value || '').toLocaleLowerCase()].map((character) => {
    if (character === '*') return '%'
    if (character === '?') return '_'
    return /[a-z0-9]/.test(character) ? character : ''
  }).join('')
}

function rawWildcardPattern(value) {
  return [...String(value || '').toLocaleLowerCase()].map((character) => {
    if (character === '*') return '%'
    if (character === '?') return '_'
    if (character === '%' || character === '_' || character === '\\') return `\\${character}`
    return character
  }).join('')
}

function wildcardMatches(value, pattern) {
  const expression = [...String(pattern || '')].map((character) => {
    if (character === '*') return '.*'
    if (character === '?') return '.'
    return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
  return new RegExp(`^${expression}$`, 'i').test(String(value || ''))
}

function seriesNameFromSegment(segment) {
  const withoutExtension = segment.replace(/\.[^.]+$/, '')
  const withoutRange = withoutExtension.replace(/\s*\([^)]*\d[^)]*\)\s*$/, '')
  return withoutRange
    .replace(/\s*(?:#|no\.?|issue)\s*[\w.-]+$/i, '')
    .replace(/(?:[\s_-])\d+(?:\.\d+)?$/, '')
    .replace(/(?:^|[\s_-])(?:v|vol\.?)[\s_-]*\d+\b/gi, ' ')
    .trim()
}

function candidateInput(comic, parameters = {}) {
  const title = String(parameters.title || '').trim()
  const number = String(parameters.number || '').trim()
  const volume = String(parameters.volume || '').trim()
  const fileName = comic.fileName.replace(/\.[^.]+$/, '')
  const parsed = fileName.match(/^(.*?)\s*(?:#|no\.?|issue)\s*([\w.-]+)$/i) || fileName.match(/^(.*?)(?:[\s_-]+)(\d+(?:\.\d+)?)(?:\s*\([^)]*\))?$/)
  const path = comic.path || ''
  const pathSegments = path.split('/').filter(Boolean).map(seriesNameFromSegment)
  const rawTerms = title ? [title] : [parsed?.[1], seriesNameFromSegment(fileName), ...pathSegments]
  const terms = [...new Map(rawTerms
    .map((term) => (term || '').trim())
    .filter((term) => normalize(term).length >= 3)
    .map((term) => [normalize(term), term])).values()]

  return {
    series: terms.slice(0, 6),
    number,
    volume,
  }
}

function storiesForGcdIssue(database, issueId) {
  let statement = gcdStoryStatementCache.get(database)
  if (!statement) {
    statement = database.prepare(`SELECT gs.id, gst.name AS type, gs.sequence_number AS sequenceNumber,
      gs.title, gs.feature, gs.page_count AS pageCount, gs.script, gs.pencils, gs.inks, gs.colors,
      gs.letters, gs.editing, gs.genre, gs.characters, gs.synopsis, gs.notes, gs.first_line AS firstLine
      FROM gcd_story gs
      LEFT JOIN gcd_story_type gst ON gst.id = gs.type_id
      WHERE gs.issue_id = ? AND gs.deleted = 0 ORDER BY gs.sequence_number`)
    gcdStoryStatementCache.set(database, statement)
  }
  return statement.all(issueId)
}

const gcdIssueSelect = `SELECT i.id, i.number, i.volume, i.variant_of_id AS variantOfId, i.variant_name AS variantName, i.title,
  i.publication_date AS publicationDate, i.key_date AS keyDate, i.price, i.page_count AS pageCount,
  i.editing, i.indicia_frequency AS indiciaFrequency, i.notes AS issueNotes, i.isbn, i.barcode,
  i.rating, i.on_sale_date AS onSaleDate, s.name AS seriesName, s.format AS seriesFormat,
  p.name AS publisherName, ip.name AS indiciaPublisher,
  COALESCE((SELECT group_concat(DISTINCT b.name) FROM gcd_issue_brand_emblem ibe
    JOIN gcd_brand b ON b.id = ibe.brand_id
    WHERE ibe.issue_id = i.id AND b.deleted = 0), '') AS publisherBrand
  FROM gcd_issue i
  JOIN gcd_series s ON s.id = i.series_id
  LEFT JOIN gcd_publisher p ON p.id = s.publisher_id
  LEFT JOIN gcd_indicia_publisher ip ON ip.id = i.indicia_publisher_id`

function findGcdMatches(comic, parameters, suppliedDatabase, includeStories = true) {
  if (!existsSync(gcdPath)) throw new Error(`GCD database not found at ${gcdPath}. Set YAC_GCD_DATABASE_PATH to choose another database.`)
  const input = candidateInput(comic, parameters)
  if (!input.series.length) throw new Error('No usable series name could be derived from this comic filename or path. Enter a series title to refine the search.')
  const database = suppliedDatabase || new Database(gcdPath, { readonly: true, fileMustExist: true })
  try {
    const normalizedSeries = "lower(replace(replace(replace(replace(replace(s.name, ' ', ''), '-', ''), '.', ''), '''', ''), ':', ''))"
    const filters = ['i.deleted = 0', 's.deleted = 0']
    const filterParameters = []
    if (input.number) {
      if (hasWildcard(input.number)) {
        filters.push("i.number LIKE ? ESCAPE '\\' COLLATE NOCASE")
        filterParameters.push(rawWildcardPattern(input.number))
      } else {
        filters.push('i.number = ? COLLATE NOCASE')
        filterParameters.push(normalizeIssueNumber(input.number) || input.number)
      }
    }
    if (input.volume) {
      if (hasWildcard(input.volume)) {
        filters.push("CAST(i.volume AS TEXT) LIKE ? ESCAPE '\\' COLLATE NOCASE")
        filterParameters.push(rawWildcardPattern(input.volume))
      } else {
        filters.push('i.volume = ?')
        filterParameters.push(normalizeNumber(input.volume))
      }
    }
    const selectMatches = (seriesCondition, seriesParameters) => database.prepare(`${gcdIssueSelect}
      WHERE ${[...filters, `(${seriesCondition})`].join(' AND ')}
      LIMIT 100`).all(...filterParameters, ...seriesParameters)
    const exactSeries = input.series.filter((term) => !hasWildcard(term))
    const exactRows = exactSeries.length
      ? selectMatches(exactSeries.map(() => 's.name = ? COLLATE NOCASE').join(' OR '), exactSeries)
      : []
    const rows = exactRows.length ? exactRows : selectMatches(
      input.series.map(() => `${normalizedSeries} LIKE ?`).join(' OR '),
      input.series.map((term) => {
        const pattern = normalizedWildcardPattern(term)
        return hasWildcard(term) ? pattern : `%${pattern}%`
      }),
    )
    const candidates = canonicalGcdCandidates(rows.map((row) => {
      const exactSeriesMatch = input.series.some((term) => !hasWildcard(term) && normalize(row.seriesName) === normalize(term))
      const issueMatches = input.number && !hasWildcard(input.number) && normalizeIssueNumber(row.number) === normalizeIssueNumber(input.number)
      const volumeMatches = input.volume && !hasWildcard(input.volume) && normalizeNumber(row.volume) === normalizeNumber(input.volume)
      const partialSeries = input.series.some((term) => hasWildcard(term) ? wildcardMatches(row.seriesName, term) : normalize(row.seriesName).includes(normalize(term)) || normalize(term).includes(normalize(row.seriesName)))
      const volumePenalty = !input.volume && normalizeNumber(row.volume) ? 30 : 0
      const score = Math.max(0, Math.min(100, (exactSeriesMatch ? 80 : partialSeries ? 45 : 0) + (issueMatches ? 20 : 0) + (volumeMatches ? 10 : 0) + (comic.publisher && normalize(row.publisherName) === normalize(comic.publisher) ? 5 : 0) - volumePenalty))
      return { ...row, score, confident: score >= 100 }
    })).slice(0, 12)
    return candidates.map((candidate) => {
      const match = { ...candidate, stories: includeStories ? storiesForGcdIssue(database, candidate.id) : [] }
      return { ...match, proposedFields: includeStories ? extractGcdFields(database, match) : fieldsFromMatch(match) }
    })
  } finally { if (!suppliedDatabase) database.close() }
}

function loadLibrary(filters) {
  const database = openLibrary()
  const enrichment = enrichmentDatabase()
  try {
    const libraryColumns = new Set(database.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
    const folders = database.prepare('SELECT id, parentId, name, path, numChildren FROM folder ORDER BY path COLLATE NOCASE').all()
    const selectedFolderId = Number(filters.folderId)
    const where = selectedFolderId === allComicsFolderId ? [] : ['c.parentId = ?']
    const parameters = selectedFolderId === allComicsFolderId ? [] : [Number.isInteger(selectedFolderId) && selectedFolderId > 0 ? selectedFolderId : libraryRootFolderId]
    if (filters.search?.trim()) {
      const query = `%${filters.search.trim()}%`
      where.push('(c.fileName LIKE ? COLLATE NOCASE OR ci.title LIKE ? COLLATE NOCASE OR ci.number LIKE ? COLLATE NOCASE OR ci.publisher LIKE ? COLLATE NOCASE OR ci.writer LIKE ? COLLATE NOCASE OR ci.series LIKE ? COLLATE NOCASE)')
      parameters.push(query, query, query, query, query, query)
    }
    if (filters.metadata === 'missing') where.push("TRIM(COALESCE(ci.title, '')) = ''")
    if (filters.metadata === 'complete') where.push("TRIM(COALESCE(ci.title, '')) != ''")
    if (filters.reading === 'read') where.push('ci.read = 1')
    if (filters.reading === 'unread') where.push('COALESCE(ci.read, 0) = 0')
    if (filters.gcdStatus === 'pending') {
      const updatedIds = enrichment.prepare('SELECT comic_info_id FROM enrichment').all().map((row) => row.comic_info_id)
      if (updatedIds.length) {
        where.push(`ci.id NOT IN (${updatedIds.map(() => '?').join(', ')})`)
        parameters.push(...updatedIds)
      }
    }
    if (filters.publisher && filters.publisher !== 'all') { where.push('ci.publisher = ?'); parameters.push(filters.publisher) }
    const condition = where.length ? where.join(' AND ') : '1 = 1'
    const total = database.prepare(`SELECT COUNT(*) AS total FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId WHERE ${condition}`).get(...parameters).total
    const paginated = selectedFolderId === allComicsFolderId
    const pageSize = paginated ? Math.max(24, Math.min(Number(filters.pageSize) || defaultPageSize, 240)) : Math.max(total, 1)
    const page = paginated ? Math.max(1, Math.min(Number(filters.page) || 1, Math.max(1, Math.ceil(total / pageSize)))) : 1
    const proposalFieldsByComicInfoId = new Map(enrichment.prepare('SELECT comic_info_id, fields_json FROM enrichment').all().flatMap((row) => {
      try {
        const fields = JSON.parse(row.fields_json)
        return fields && typeof fields === 'object' && !Array.isArray(fields) ? [[row.comic_info_id, fields]] : []
      } catch {
        return []
      }
    }))
    const orderBy = filters.sort === 'path' ? 'c.path COLLATE NOCASE, c.fileName COLLATE NOCASE, c.id' : "COALESCE(NULLIF(ci.title, ''), c.fileName) COLLATE NOCASE"
    const comics = database.prepare(`SELECT ci.*, c.id, c.comicInfoId, c.fileName, c.path FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId WHERE ${condition} ORDER BY ${orderBy}${paginated ? ' LIMIT ? OFFSET ?' : ''}`).all(...parameters, ...(paginated ? [pageSize, (page - 1) * pageSize] : [])).map((comic) => {
      const proposedFields = proposalFieldsByComicInfoId.get(comic.comicInfoId) || {}
      const pendingFields = Object.fromEntries(Object.entries(yacReaderMappings).flatMap(([enrichmentField, libraryField]) => {
        const value = enrichmentField === 'onSaleDate' ? normalizeGcdDate(proposedFields[enrichmentField]) : proposedFields[enrichmentField]
        const validIssueNumber = enrichmentField !== 'issueNumber' || Boolean(normalizeIssueNumber(value))
        return hasValue(value) && validIssueNumber && libraryColumns.has(libraryField) && !hasValue(comic[libraryField]) ? [[enrichmentField, String(value)]] : []
      }))
      return { ...comic, proposedFields, pendingFields, coverUrl: coverUrl(comic.hash) }
    })
    const publishers = database.prepare("SELECT DISTINCT publisher FROM comic_info WHERE TRIM(COALESCE(publisher, '')) != '' ORDER BY publisher COLLATE NOCASE LIMIT 500").all().map((row) => row.publisher)
    return { folders, comics, total, page, pageSize, publishers, libraryPath }
  } finally {
    enrichment.close()
    database.close()
  }
}

function getComicMetadata(comicId) {
  const database = openLibrary()
  try {
    return database.prepare(`SELECT
      c.id AS comicId, c.parentId AS folderId, c.comicInfoId, c.fileName, c.path,
      ci.*
      FROM comic c
      JOIN comic_info ci ON ci.id = c.comicInfoId
      WHERE c.id = ?`).get(comicId) || null
  } finally { database.close() }
}

async function saveComicMetadata(comicInfoId, fields) {
  if (!Number.isInteger(comicInfoId)) throw new Error('A valid comic info ID is required.')
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Comic metadata must be an object.')

  const updates = Object.entries(fields).filter(([field]) => editableComicInfoFields.has(field))
  if (!updates.length) throw new Error('No editable comic metadata was provided.')
  const date = fields.date === null || fields.date === undefined ? '' : String(fields.date)
  if (date && !/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{1,4})$/.test(date)) throw new Error('Date must use YYYY-MM-DD or day/month/year format.')
  if (fields.type !== undefined && (!Number.isInteger(Number(fields.type)) || Number(fields.type) < 0 || Number(fields.type) > 4)) throw new Error('Comic type is invalid.')

  const backupPath = `${libraryPath}.yacgcd-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ydb`
  const source = openLibrary()
  try {
    await source.backup(backupPath)
  } finally {
    source.close()
  }

  const database = new Database(libraryPath, { fileMustExist: true })
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
    const writable = updates.filter(([field]) => columns.has(field))
    if (!writable.length) throw new Error('This YACReader library does not support the requested metadata fields.')
    const assignments = writable.map(([field]) => `${field} = ?`)
    const values = writable.map(([field, value]) => {
      if (field === 'color') return value ? 1 : 0
      if (field === 'type') return Number(value)
      return value === null || value === undefined ? '' : String(value)
    })
    if (columns.has('lastTimeMetadataSet')) {
      assignments.push('lastTimeMetadataSet = ?')
      values.push(Math.floor(Date.now() / 1000))
    }
    const result = database.transaction(() => database.prepare(`UPDATE comic_info SET ${assignments.join(', ')} WHERE id = ?`).run(...values, comicInfoId))()
    if (!result.changes) throw new Error('Comic metadata could not be updated.')
    return { backupPath }
  } catch (error) {
    throw new Error(`No metadata changes were committed. A backup was created at ${backupPath}. ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    database.close()
  }
}

async function bulkUpdateComicMetadata(comicInfoIds, fields, incrementFields = []) {
  const ids = [...new Set(comicInfoIds)]
  if (!ids.length || ids.some((comicInfoId) => !Number.isInteger(comicInfoId))) throw new Error('Select one or more valid comics to update.')
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Bulk metadata must be an object.')
  const allowedFields = new Set(['series', 'title', 'number', 'volume', 'publisher'])
  const updates = Object.entries(fields).filter(([field]) => allowedFields.has(field))
  if (!updates.length) throw new Error('Choose at least one metadata field to update.')
  const increments = new Set(incrementFields)
  if ([...increments].some((field) => field !== 'number' && field !== 'volume')) throw new Error('Only issue and volume can be incremented.')
  for (const field of increments) {
    if (!Number.isFinite(Number(fields[field]))) throw new Error(`${field === 'number' ? 'Issue' : 'Volume'} must start with a number when incrementing.`)
  }

  const backupPath = `${libraryPath}.yacgcd-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ydb`
  const source = openLibrary()
  try {
    await source.backup(backupPath)
  } finally {
    source.close()
  }

  const database = new Database(libraryPath, { fileMustExist: true })
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
    const writable = updates.filter(([field]) => columns.has(field))
    if (!writable.length) throw new Error('This YACReader library does not support the requested metadata fields.')
    const assignments = writable.map(([field]) => `${field} = ?`)
    if (columns.has('lastTimeMetadataSet')) assignments.push('lastTimeMetadataSet = ?')
    const update = database.prepare(`UPDATE comic_info SET ${assignments.join(', ')} WHERE id = ?`)
    const timestamp = Math.floor(Date.now() / 1000)
    database.transaction(() => ids.forEach((comicInfoId, index) => {
      const values = writable.map(([field, value]) => increments.has(field) ? String(Number(value) + index) : String(value ?? ''))
      if (columns.has('lastTimeMetadataSet')) values.push(timestamp)
      const result = update.run(...values, comicInfoId)
      if (!result.changes) throw new Error(`Comic metadata ${comicInfoId} could not be updated.`)
    }))()
    return { backupPath, updatedComics: ids.length }
  } catch (error) {
    throw new Error(`No bulk metadata changes were committed. A backup was created at ${backupPath}. ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    database.close()
  }
}

async function extractFolderPathMetadata({ folderId, recursive = true, overwriteExisting = false } = {}) {
  const targetFolderId = Number(folderId)
  if (!Number.isInteger(targetFolderId) || targetFolderId < libraryRootFolderId) throw new Error('Choose a library folder before extracting metadata.')

  const source = openLibrary()
  let proposedUpdates
  try {
    const columns = new Set(source.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
    const descendantQuery = `WITH RECURSIVE descendants(id) AS (
      SELECT ?
      UNION ALL
      SELECT f.id FROM folder f JOIN descendants d ON f.parentId = d.id WHERE f.id != d.id
    )`
    const comics = source.prepare(`${recursive ? descendantQuery : ''}
      SELECT c.comicInfoId, c.fileName, c.path, ci.*
      FROM comic c
      JOIN comic_info ci ON ci.id = c.comicInfoId
      WHERE c.parentId ${recursive ? 'IN (SELECT id FROM descendants)' : '= ?'}`).all(targetFolderId)
    proposedUpdates = comics.map((comic) => {
      const extracted = extractPathMetadata(comic)
      const updates = Object.entries(extracted).filter(([field, value]) => editableComicInfoFields.has(field) && columns.has(field) && (overwriteExisting || !hasValue(comic[field])) && hasValue(value))
      const skippedExisting = Object.entries(extracted).filter(([field, value]) => editableComicInfoFields.has(field) && columns.has(field) && !overwriteExisting && hasValue(comic[field]) && hasValue(value)).length
      return { comicInfoId: comic.comicInfoId, updates, skippedExisting }
    })
    const candidates = proposedUpdates.filter(({ updates }) => updates.length)
    if (!candidates.length) return { scanned: comics.length, updatedComics: 0, updatedFields: 0, skippedExisting: proposedUpdates.reduce((total, update) => total + update.skippedExisting, 0), backupPath: null }

    const backupPath = `${libraryPath}.yacgcd-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ydb`
    await source.backup(backupPath)
    const database = new Database(libraryPath, { fileMustExist: true })
    try {
      const writableColumns = new Set(database.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
      const statements = new Map()
      const timestamp = Math.floor(Date.now() / 1000)
      const updateStatement = (fields) => {
        const key = fields.map(([field]) => field).join(',')
        if (!statements.has(key)) {
          const assignments = fields.map(([field]) => `${field} = ?`)
          if (writableColumns.has('lastTimeMetadataSet')) assignments.push('lastTimeMetadataSet = ?')
          statements.set(key, database.prepare(`UPDATE comic_info SET ${assignments.join(', ')} WHERE id = ?`))
        }
        return statements.get(key)
      }
      database.transaction(() => candidates.forEach(({ comicInfoId, updates }) => {
        const writable = updates.filter(([field]) => writableColumns.has(field))
        if (!writable.length) return
        const values = writable.map(([, value]) => String(value))
        if (writableColumns.has('lastTimeMetadataSet')) values.push(timestamp)
        const result = updateStatement(writable).run(...values, comicInfoId)
        if (!result.changes) throw new Error(`Comic metadata ${comicInfoId} could not be updated.`)
      }))()
      return { scanned: comics.length, updatedComics: candidates.length, updatedFields: candidates.reduce((total, candidate) => total + candidate.updates.length, 0), skippedExisting: proposedUpdates.reduce((total, update) => total + update.skippedExisting, 0), backupPath }
    } catch (error) {
      throw new Error(`No extracted metadata changes were committed. A backup was created at ${backupPath}. ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      database.close()
    }
  } finally {
    source.close()
  }
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function saveEnrichmentFields(database, comicInfoId, fields) {
  const normalizedFields = { ...fields, issueNumber: normalizeIssueNumber(fields.issueNumber) }
  saveGcdProposal(database, comicInfoId, normalizedFields)
}

async function automaticallyProposeExactMatches(onProgress, { folderId = libraryRootFolderId, comicInfoIds = [], recursive = true, overwriteExisting = false, refinement = {} } = {}) {
  const library = openLibrary()
  const enrichment = enrichmentDatabase()
  const gcd = new Database(gcdPath, { readonly: true, fileMustExist: true })
  try {
    const targetFolderId = Number.isInteger(folderId) && folderId > 0 ? folderId : libraryRootFolderId
    const selectedComicInfoIds = [...new Set(comicInfoIds.filter((comicInfoId) => Number.isInteger(comicInfoId) && comicInfoId > 0))]
    const existingIds = new Set(enrichment.prepare('SELECT comic_info_id FROM enrichment').all().map((row) => row.comic_info_id))
    const descendantQuery = `WITH RECURSIVE descendants(id) AS (
        SELECT ?
        UNION ALL
        SELECT f.id FROM folder f JOIN descendants d ON f.parentId = d.id WHERE f.id != d.id
      )`
    const comics = selectedComicInfoIds.length
      ? library.prepare(`SELECT c.comicInfoId, c.fileName, c.path, ci.title, ci.number, ci.volume, ci.publisher
        FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId
        WHERE c.comicInfoId IN (${selectedComicInfoIds.map(() => '?').join(', ')})`).all(...selectedComicInfoIds)
      : library.prepare(`${recursive ? descendantQuery : ''}
      SELECT c.comicInfoId, c.fileName, c.path, ci.title, ci.number, ci.volume, ci.publisher
      FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId
      WHERE c.parentId ${recursive ? 'IN (SELECT id FROM descendants)' : '= ?'}`).all(targetFolderId)
    const worklist = overwriteExisting ? comics : comics.filter((comic) => !existingIds.has(comic.comicInfoId))
    const proposed = []
    let unmatched = 0
    onProgress({ scanned: 0, total: worklist.length, proposed: 0, unmatched: 0 })
    for (const [index, comic] of worklist.entries()) {
      try {
        const refinedComic = {
          ...comic,
          title: String(refinement.title || '').trim() || comic.title,
          volume: String(refinement.volume || '').trim() || comic.volume,
          publisher: String(refinement.publisher || '').trim() || comic.publisher,
        }
        const exactMatches = findGcdMatches(refinedComic, {
          title: String(refinement.title || '').trim() || String(comic.title || ''),
          number: String(comic.number || ''),
          volume: String(refinement.volume || '').trim() || String(comic.volume || ''),
        }, gcd, false).filter((match) => match.score === 100)
        if (exactMatches.length !== 1) {
          unmatched += 1
        } else {
          const exactMatch = { ...exactMatches[0], stories: storiesForGcdIssue(gcd, exactMatches[0].id) }
          const generated = extractGcdFields(gcd, exactMatch)
          proposed.push({ comicInfoId: comic.comicInfoId, fields: generated })
        }
      } catch {
        unmatched += 1
      }

      const scanned = index + 1
      if (scanned === worklist.length || scanned % 10 === 0) onProgress({ scanned, total: worklist.length, proposed: proposed.length, unmatched })
      await new Promise((resolve) => setImmediate(resolve))
    }
    const saveProposals = enrichment.transaction(() => proposed.forEach(({ comicInfoId, fields }) => saveEnrichmentFields(enrichment, comicInfoId, fields)))
    saveProposals()
    return { scanned: worklist.length, proposed: proposed.length, unmatched }
  } finally {
    gcd.close()
    enrichment.close()
    library.close()
  }
}

async function previewGcdSync(onProgress) {
  const library = openLibrary()
  let enrichment
  let gcd
  try {
    enrichment = enrichmentDatabase()
    gcd = new Database(gcdPath, { readonly: true, fileMustExist: true })
    const columns = new Set(library.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
    const comics = library.prepare('SELECT c.comicInfoId, c.fileName, c.path, ci.* FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId GROUP BY ci.id').all()
    const proposals = new Map(enrichment.prepare('SELECT comic_info_id, fields_json FROM enrichment').all().map((row) => [row.comic_info_id, row.fields_json]))
    const findById = gcd.prepare(`${gcdIssueSelect} WHERE i.id = ? AND i.deleted = 0 AND s.deleted = 0`)
    const plan = await buildGcdSyncPlan({
      comics, columns, mappings: yacReaderMappings, onProgress,
      resolveFields: (comic) => {
        const savedFields = JSON.parse(proposals.get(comic.comicInfoId) || '{}')
        const inferred = extractPathMetadata(comic)
        const series = comic.series || inferred.series || comic.title || inferred.title || ''
        const number = comic.number || inferred.number || ''
        const volume = comic.volume || inferred.volume || ''
        const match = resolveGcdSyncCandidate(savedFields.gcdIssueId, {
          findById: (issueId) => findById.get(issueId),
          findCandidates: () => normalizeIssueNumber(number) ? findGcdMatches(comic, { title: series, number, volume }, gcd, false) : [],
        })
        return match ? extractGcdFields(gcd, { ...match, stories: storiesForGcdIssue(gcd, match.id) }) : null
      },
    })
    persistGcdLinks(enrichment, plan.matchedLinks)
    return { ...plan, planId: randomUUID(), gcdSnapshot: path.basename(gcdPath) }
  } finally {
    gcd?.close()
    enrichment?.close()
    library.close()
  }
}

async function applyGcdSync(plan, replaceExisting) {
  const changes = gcdSyncChanges(plan, replaceExisting)
  if (!changes.length) return { updatedFields: 0, updatedComics: 0, backupPath: null }
  const backupPath = `${libraryPath}.yacgcd-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ydb`
  const source = openLibrary()
  try { await source.backup(backupPath) } finally { source.close() }
  const library = new Database(libraryPath, { fileMustExist: true })
  try {
    const updatedFields = applyGcdSyncChanges(library, changes, yacReaderMappings)
    return { updatedFields, updatedComics: new Set(changes.map((change) => change.comicInfoId)).size, backupPath }
  } catch (error) {
    throw new Error(`No library changes were committed. Backup: ${backupPath}. ${error instanceof Error ? error.message : String(error)}`)
  } finally { library.close() }
}

function buildImportPlan() {
  const library = openLibrary()
  const enrichment = enrichmentDatabase()
  try {
    const libraryColumns = new Set(library.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
    const proposedRows = enrichment.prepare('SELECT comic_info_id, fields_json FROM enrichment ORDER BY updated_at').all()
    const findComic = library.prepare('SELECT c.fileName, ci.* FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId WHERE ci.id = ?')
    const changes = []
    let skippedExisting = 0
    let skippedUnsupported = 0
    let skippedInvalidIssue = 0
    let missingComics = 0

    for (const row of proposedRows) {
      const fields = JSON.parse(row.fields_json)
      const comic = findComic.get(row.comic_info_id)
      if (!comic) {
        missingComics += 1
        continue
      }
      for (const [enrichmentField, libraryField] of Object.entries(yacReaderMappings)) {
        const value = enrichmentField === 'onSaleDate' ? normalizeGcdDate(fields[enrichmentField]) : fields[enrichmentField]
        if (!hasValue(value)) continue
        if (enrichmentField === 'issueNumber' && !normalizeIssueNumber(value)) {
          skippedInvalidIssue += 1
          continue
        }
        if (!libraryColumns.has(libraryField)) {
          skippedUnsupported += 1
          continue
        }
        if (hasValue(comic[libraryField])) {
          skippedExisting += 1
          continue
        }
        changes.push({ comicInfoId: row.comic_info_id, fileName: comic.fileName, enrichmentField, libraryField, value: String(value) })
      }
    }

    return {
      proposedRecords: proposedRows.length,
      eligibleComics: new Set(changes.map((change) => change.comicInfoId)).size,
      changes,
      skippedExisting,
      skippedUnsupported,
      skippedInvalidIssue,
      missingComics,
    }
  } finally {
    enrichment.close()
    library.close()
  }
}

async function importEnrichment() {
  const plan = buildImportPlan()
  if (!plan.changes.length) return { ...plan, updatedFields: 0, backupPath: null }

  const backupPath = `${libraryPath}.yacgcd-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ydb`
  const source = openLibrary()
  try {
    await source.backup(backupPath)
  } finally {
    source.close()
  }

  const library = new Database(libraryPath, { fileMustExist: true })
  try {
    const columns = new Set(library.prepare('PRAGMA table_info(comic_info)').all().map((column) => column.name))
    const metadataTimestamp = Math.floor(Date.now() / 1000)
    let updatedFields = 0
    const updateChanges = library.transaction(() => {
      for (const change of plan.changes) {
        const timestampClause = columns.has('lastTimeMetadataSet') ? ', lastTimeMetadataSet = ?' : ''
        const result = library.prepare(`UPDATE comic_info SET ${change.libraryField} = ?${timestampClause} WHERE id = ? AND (${change.libraryField} IS NULL OR TRIM(${change.libraryField}) = '')`).run(change.value, ...(timestampClause ? [metadataTimestamp] : []), change.comicInfoId)
        updatedFields += result.changes
      }
    })
    updateChanges()
    return { ...plan, updatedFields, backupPath }
  } catch (error) {
    throw new Error(`No library changes were committed. A backup was created at ${backupPath}. ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    library.close()
  }
}

function importEnrichmentPackage(filePath) {
  let packageData
  try {
    packageData = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read the update package. ${error instanceof Error ? error.message : String(error)}`)
  }
  if (packageData?.format !== 'yac-gcd-update-package/v1' || !Array.isArray(packageData.updates)) throw new Error('This is not a YAC GCD update package.')

  const updates = packageData.updates.map((update) => {
    if (!Number.isInteger(update?.comicInfoId) || !update.fields || typeof update.fields !== 'object' || Array.isArray(update.fields)) throw new Error('The update package contains an invalid record.')
    return { comicInfoId: update.comicInfoId, fields: update.fields }
  })
  const enrichment = enrichmentDatabase()
  try {
    enrichment.transaction(() => updates.forEach((update) => saveEnrichmentFields(enrichment, update.comicInfoId, update.fields)))()
    return { imported: updates.length, filePath }
  } finally {
    enrichment.close()
  }
}

app.whenReady().then(() => {
  protocol.handle('yac-cover', (request) => {
    const hash = new URL(request.url).hostname
    if (!/^[a-f0-9]{16,128}$/i.test(hash)) return new Response(null, { status: 404 })
    const coverPath = path.join(coversPath, `${hash}.jpg`)
    if (!existsSync(coverPath)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(coverPath).href)
  })
  ipcMain.handle('library:load', (_event, filters) => loadLibrary(filters))
  ipcMain.handle('gcd:browse', (_event, options) => {
    const gcd = new Database(gcdPath, { readonly: true, fileMustExist: true })
    try { return browseGcdRecords(gcd, options) } finally { gcd.close() }
  })
  ipcMain.handle('gcd:create-mappings', async (_event, options) => {
    const library = openLibrary()
    const gcd = new Database(gcdPath, { readonly: true, fileMustExist: true })
    const enrichment = enrichmentDatabase()
    try {
      return await createGcdMappings({ ...options, library, gcd, enrichment,
        resolveFields: (issueId) => {
          const match = gcd.prepare(`${gcdIssueSelect} WHERE i.id = ? AND +i.deleted = 0 AND +s.deleted = 0`).get(issueId)
          return match ? extractGcdFields(gcd, { ...match, stories: storiesForGcdIssue(gcd, issueId) }) : null
        },
      })
    } finally { enrichment.close(); gcd.close(); library.close() }
  })
  ipcMain.handle('comic:metadata', (_event, comicId) => getComicMetadata(comicId))
  ipcMain.handle('comic:update-metadata', (_event, comicId, fields) => saveComicMetadata(comicId, fields))
  ipcMain.handle('comic:bulk-update-metadata', (_event, comicInfoIds, fields, incrementFields) => bulkUpdateComicMetadata(comicInfoIds, fields, incrementFields))
  ipcMain.handle('comic:extract-path-metadata', (_event, options) => extractFolderPathMetadata(options))
  ipcMain.handle('enrichment:preview-import', () => buildImportPlan())
  ipcMain.handle('enrichment:import', () => importEnrichment())
  ipcMain.handle('gcd:preview-sync', async (event) => {
    const senderId = event.sender.id
    if (gcdSyncBusy.has(senderId)) throw new Error('A GCD sync operation is already running.')
    gcdSyncBusy.add(senderId)
    pendingGcdSyncPlans.delete(senderId)
    try {
      const plan = await previewGcdSync((progress) => { if (!event.sender.isDestroyed()) event.sender.send('gcd:sync-progress', progress) })
      if (!event.sender.isDestroyed()) pendingGcdSyncPlans.set(senderId, plan)
      return plan
    } finally { gcdSyncBusy.delete(senderId) }
  })
  ipcMain.handle('gcd:apply-sync', async (event, { planId, replaceExisting = false } = {}) => {
    const senderId = event.sender.id
    if (gcdSyncBusy.has(senderId)) throw new Error('A GCD sync operation is already running.')
    const plan = pendingGcdSyncPlans.get(senderId)
    if (!plan || plan.planId !== planId) throw new Error('Generate a new GCD sync preview before applying updates.')
    gcdSyncBusy.add(senderId)
    try {
      const result = await applyGcdSync(plan, replaceExisting)
      pendingGcdSyncPlans.delete(senderId)
      return result
    } finally { gcdSyncBusy.delete(senderId) }
  })
  ipcMain.handle('enrichment:import-package', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import YACReader update package', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    return result.canceled || !result.filePaths[0] ? { canceled: true, imported: 0 } : { canceled: false, ...importEnrichmentPackage(result.filePaths[0]) }
  })
  ipcMain.handle('enrichment:auto-match-exact', (event, options) => automaticallyProposeExactMatches((progress) => event.sender.send('enrichment:auto-match-progress', progress), options))
  ipcMain.handle('gcd:match', (_event, comic, parameters) => findGcdMatches(comic, parameters))
  ipcMain.handle('enrichment:get', (_event, comicInfoId) => {
    const database = enrichmentDatabase()
    try { return JSON.parse(database.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = ?').get(comicInfoId)?.fields_json || '{}') } finally { database.close() }
  })
  ipcMain.handle('enrichment:save', (_event, comicInfoId, fields) => {
    const database = enrichmentDatabase()
    try { saveEnrichmentFields(database, comicInfoId, fields) } finally { database.close() }
  })
  ipcMain.handle('enrichment:list', () => {
    const database = enrichmentDatabase()
    try {
      const library = openLibrary()
      try {
        return listGcdProposals(database, library)
      } finally { library.close() }
    } finally { database.close() }
  })
  ipcMain.handle('enrichment:remove', (_event, comicInfoIds) => {
    const database = enrichmentDatabase()
    try { return { removed: removeGcdProposals(database, comicInfoIds) } } finally { database.close() }
  })
  ipcMain.handle('enrichment:export', async () => {
    const database = enrichmentDatabase()
    const rows = database.prepare('SELECT comic_info_id AS comicInfoId, fields_json AS fields, updated_at AS updatedAt FROM enrichment ORDER BY updated_at DESC').all()
    database.close()
    const result = await dialog.showSaveDialog({ title: 'Export YACReader update package', defaultPath: 'yac-gcd-updates.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (!result.canceled && result.filePath) writeFileSync(result.filePath, JSON.stringify({ format: 'yac-gcd-update-package/v1', sourceLibrary: libraryPath, updates: rows.map((row) => ({ ...row, fields: JSON.parse(row.fields) })) }, null, 2))
  })
  const window = new BrowserWindow({ width: 1500, height: 930, minWidth: 1100, minHeight: 700, backgroundColor: '#f7f8f6', webPreferences: { preload: path.join(appDirectory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } })
  const senderId = window.webContents.id
  window.webContents.once('destroyed', () => pendingGcdSyncPlans.delete(senderId))
  const developmentUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
  if (app.isPackaged) window.loadFile(path.join(appDirectory, '../dist/index.html'))
  else window.loadURL(developmentUrl)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })