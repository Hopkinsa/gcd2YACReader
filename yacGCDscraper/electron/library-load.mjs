import { statSync } from 'node:fs'

function fileIdentity(filePath) {
  const file = statSync(filePath, { throwIfNoEntry: false })
  return file ? `${file.dev}:${file.ino}` : null
}

export function createLibraryReader({ openLibrary, enrichmentDatabase, libraryPath, allComicsFolderId = 0, libraryRootFolderId = 1, defaultPageSize = 120 }) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const statements = new Map()
  let database, readSnapshot, libraryVersion, enrichmentVersion, catalog, orderedCache, files

  function statement(sql) {
    if (!statements.has(sql)) {
      if (statements.size >= 32) statements.delete(statements.keys().next().value)
      statements.set(sql, database.prepare(sql))
    }
    return statements.get(sql)
  }

  function readLibrary(filters) {
    const currentLibraryVersion = statement('PRAGMA main.data_version').pluck().get()
    const currentEnrichmentVersion = statement('PRAGMA gcd_enrichment.data_version').pluck().get()
    if (currentLibraryVersion !== libraryVersion) {
      catalog = undefined
      orderedCache = undefined
      libraryVersion = currentLibraryVersion
    }
    if (currentEnrichmentVersion !== enrichmentVersion) {
      if (orderedCache?.pending) orderedCache = undefined
      enrichmentVersion = currentEnrichmentVersion
    }
    if (!catalog) {
      catalog = {
        libraryColumns: new Set(statement('PRAGMA table_info(comic_info)').all().map((column) => column.name)),
        folders: statement('SELECT id, parentId, name, path, numChildren FROM folder ORDER BY path COLLATE NOCASE').all(),
        publishers: statement("SELECT DISTINCT publisher FROM comic_info WHERE TRIM(COALESCE(publisher, '')) != '' ORDER BY publisher COLLATE NOCASE LIMIT 500").all().map((row) => row.publisher),
      }
    }
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
    const pending = filters.gcdStatus === 'pending'
    if (pending) where.push('NOT EXISTS (SELECT 1 FROM gcd_enrichment.enrichment e WHERE e.comic_info_id = ci.id)')
    if (filters.publisher === 'missing') where.push("TRIM(COALESCE(ci.publisher, '')) = ''")
    else if (filters.publisher && filters.publisher !== 'all') {
      where.push('ci.publisher = ?')
      parameters.push(filters.publisher)
    }
    const condition = where.length ? where.join(' AND ') : '1 = 1'
    const sortField = filters.sort ?? 'title'
    if (!['path', 'series', 'title', 'number', 'volume', 'publisher', 'date'].includes(sortField)) throw new Error('Unsupported library sort field.')
    const sortColumn = sortField === 'path' ? 'c.path' : catalog.libraryColumns.has(sortField) ? `ci.${sortField}` : 'NULL'
    const sortValue = filters.sort === undefined ? "COALESCE(NULLIF(ci.title, ''), c.fileName)" : sortColumn
    const direction = filters.sortDirection === 'descending' ? -1 : 1
    const key = JSON.stringify([condition, parameters, sortValue, direction])
    if (orderedCache?.key !== key) {
      // Retain only the current result's lightweight IDs, not every visited filter or page.
      const ids = statement(`SELECT c.id, ${sortValue} AS sortValue, c.fileName
        FROM comic c JOIN comic_info ci ON ci.id = c.comicInfoId WHERE ${condition} ORDER BY c.id`).all(...parameters)
        .sort((left, right) => direction * collator.compare(String(left.sortValue ?? ''), String(right.sortValue ?? ''))
          || (sortField === 'path' ? collator.compare(left.fileName, right.fileName) : 0) || left.id - right.id)
        .map((comic) => comic.id)
      orderedCache = { key, ids, pending }
    }
    const total = orderedCache.ids.length
    const paginated = selectedFolderId === allComicsFolderId
    const pageSize = paginated ? Math.max(24, Math.min(Number(filters.pageSize) || defaultPageSize, 240)) : Math.max(total, 1)
    const page = paginated ? Math.max(1, Math.min(Number(filters.page) || 1, Math.max(1, Math.ceil(total / pageSize)))) : 1
    const pageIds = paginated ? orderedCache.ids.slice((page - 1) * pageSize, page * pageSize) : orderedCache.ids
    const comics = statement(`SELECT ci.*, c.id, c.comicInfoId, c.fileName, c.path, e.fields_json AS proposalFieldsJson
      FROM json_each(?) selected JOIN comic c ON c.id = selected.value JOIN comic_info ci ON ci.id = c.comicInfoId
      LEFT JOIN gcd_enrichment.enrichment e ON e.comic_info_id = ci.id
      ORDER BY CAST(selected.key AS INTEGER)`).all(JSON.stringify(pageIds)).map(({ proposalFieldsJson, ...comic }) => {
      let proposedFields = {}
      if (proposalFieldsJson) {
        try {
          const fields = JSON.parse(proposalFieldsJson)
          if (fields && typeof fields === 'object' && !Array.isArray(fields)) proposedFields = fields
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
      return { ...comic, proposedFields }
    })
    return { ...catalog, comics, total, page, pageSize, libraryPath }
  }

  function close() {
    if (database) database.close()
    database = readSnapshot = libraryVersion = enrichmentVersion = catalog = orderedCache = files = undefined
    statements.clear()
  }

  function load(filters) {
    if (database) {
      try {
        // SQLite's data_version detects commits, but not replacement of an open file.
        if (fileIdentity(libraryPath) !== files.library || fileIdentity(files.enrichmentPath) !== files.enrichment) close()
      } catch (error) {
        close()
        throw error
      }
    }
    if (!database) {
      const libraryIdentity = fileIdentity(libraryPath)
      database = openLibrary()
      try {
        const enrichment = enrichmentDatabase()
        try {
          files = { library: libraryIdentity, enrichmentPath: enrichment.name, enrichment: fileIdentity(enrichment.name) }
          database.prepare('ATTACH DATABASE ? AS gcd_enrichment').run(enrichment.name)
        } finally { enrichment.close() }
        readSnapshot = database.transaction(readLibrary)
      } catch (error) {
        close()
        throw error
      }
    }
    return readSnapshot(filters)
  }

  return { load, close }
}
