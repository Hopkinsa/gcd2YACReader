import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createLibraryReader } from './library-load.mjs'
import { normalizeGcdDate, yacReaderMappings } from './gcd-sync.mjs'

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
const implementation = source.slice(source.indexOf('function loadLibrary('), source.indexOf('function getComicMetadata('))

function createHarness(options) {
  const reader = createLibraryReader(options)
  const loadLibrary = runInNewContext(`${implementation}\nloadLibrary`, {
    ...options,
    libraryReader: reader,
    yacReaderMappings,
    normalizeGcdDate,
    hasValue: (value) => value !== null && value !== undefined && String(value).trim() !== '',
    normalizeIssueNumber: (value) => /^\d+(?:\.\d+)?$/.test(String(value ?? '').trim()) ? String(value).trim() : '',
  })
  return { loadLibrary, close: reader.close }
}

test('library sorting is global, natural, and stable before pagination in either direction', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const directory = mkdtempSync(path.join(tmpdir(), 'yac-library-sort-'))
  const libraryPath = path.join(directory, 'library.ydb')
  const enrichmentPath = path.join(directory, 'enrichment.db')
  const library = new Database(libraryPath)
  const enrichment = new Database(enrichmentPath)
  let harness
  try {
    library.exec(`CREATE TABLE folder (id INTEGER PRIMARY KEY, parentId INTEGER, name TEXT, path TEXT, numChildren INTEGER);
      CREATE TABLE comic (id INTEGER PRIMARY KEY, comicInfoId INTEGER, parentId INTEGER, fileName TEXT, path TEXT);
      CREATE TABLE comic_info (id INTEGER PRIMARY KEY, title TEXT, number TEXT, publisher TEXT, writer TEXT, series TEXT, read INTEGER, volume TEXT, date TEXT);
      INSERT INTO folder VALUES (1, NULL, 'Odd', '/odd', 27), (2, NULL, 'Even', '/even', 26);`)
    enrichment.exec('CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL)')
    const insertInfo = library.prepare('INSERT INTO comic_info VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertComic = library.prepare('INSERT INTO comic VALUES (?, ?, ?, ?, ?)')
    const ascendingIds = []
    library.transaction(() => {
      for (let id = 1; id <= 53; id += 1) {
        const rank = (id * 17) % 53 + 1
        ascendingIds[rank - 1] = id
        insertInfo.run(1000 + id, `${rank % 2 ? 'comic' : 'Comic'} ${rank}`, String(rank), `Publisher ${rank}`, '', `Series ${rank}`, 0, String(rank), `${2000 + rank}-01-01`)
        insertComic.run(id, 1000 + id, id % 2 ? 1 : 2, `Comic ${id}.cbz`, `/comic/${54 - rank}`)
      }
    })()
    let coversLoaded = 0
    harness = createHarness({
      openLibrary: () => new Database(libraryPath, { readonly: true, fileMustExist: true }),
      enrichmentDatabase: () => new Database(enrichmentPath),
      allComicsFolderId: 0, libraryRootFolderId: 1, defaultPageSize: 120, libraryPath,
      coverUrl: () => { coversLoaded += 1; return null },
    })
    const { loadLibrary } = harness
    const filters = { folderId: 0, page: 1, pageSize: 24, search: '', metadata: 'all', reading: 'all', publisher: 'all', gcdStatus: 'all', sort: 'title' }
    for (const sort of ['path', 'series', 'title', 'number', 'volume', 'publisher', 'date']) {
      for (const sortDirection of ['ascending', 'descending']) {
        const expected = [...ascendingIds]
        if ((sort === 'path') !== (sortDirection === 'descending')) expected.reverse()
        for (const page of [1, 2, 3]) {
          coversLoaded = 0
          const result = loadLibrary({ ...filters, sort, sortDirection, page })
          assert.equal(result.total, 53)
          assert.equal(result.page, page)
          assert.deepEqual(Array.from(result.comics, (comic) => comic.id), expected.slice((page - 1) * 24, page * 24), `${sort} ${sortDirection}, page ${page}`)
          assert.equal(coversLoaded, result.comics.length)
        }
      }
    }

    const filtered = loadLibrary({ ...filters, sort: 'number', sortDirection: 'descending', search: 'Series 5' })
    assert.equal(filtered.total, 5)
    assert.deepEqual(Array.from(filtered.comics, (comic) => comic.id), [53, 52, 51, 50, 5].map((rank) => ascendingIds[rank - 1]))
    const folder = loadLibrary({ ...filters, folderId: 1, page: 3, sortDirection: 'descending' })
    assert.equal(folder.page, 1)
    assert.equal(folder.total, 27)
    assert.deepEqual(Array.from(folder.comics, (comic) => comic.id), ascendingIds.filter((id) => id % 2).reverse())

    library.prepare('UPDATE comic_info SET title = NULL WHERE id = ?').run(1000 + ascendingIds[0])
    library.prepare("UPDATE comic_info SET title = '' WHERE id = ?").run(1000 + ascendingIds[1])
    library.prepare("UPDATE comic_info SET title = 'COMIC 3' WHERE id = ?").run(1000 + ascendingIds[3])
    const expectedTies = [
      ...ascendingIds.slice(0, 2).sort((a, b) => a - b),
      ...ascendingIds.slice(2, 4).sort((a, b) => a - b),
      ...ascendingIds.slice(4),
    ]
    const allPages = [1, 2, 3].flatMap((page) => Array.from(loadLibrary({ ...filters, page }).comics, (comic) => comic.id))
    assert.deepEqual(allPages, expectedTies)
    assert.deepEqual(Array.from(loadLibrary({ ...filters, sortDirection: 'descending', page: 3 }).comics, (comic) => comic.id), [
      ascendingIds[4], ...ascendingIds.slice(2, 4).sort((a, b) => a - b), ...ascendingIds.slice(0, 2).sort((a, b) => a - b),
    ])
  } finally {
    harness?.close()
    library.close()
    enrichment.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('GCD status filtering handles enrichment beyond the SQL variable limit without changing library data', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const directory = mkdtempSync(path.join(tmpdir(), 'yac-library-load-'))
  const libraryPath = path.join(directory, 'library.ydb')
  const enrichmentPath = path.join(directory, "enrichment's.db")
  const library = new Database(libraryPath)
  const enrichment = new Database(enrichmentPath)
  let harness
  try {
    library.exec(`CREATE TABLE folder (id INTEGER PRIMARY KEY, parentId INTEGER, name TEXT, path TEXT, numChildren INTEGER);
      CREATE TABLE comic (id INTEGER PRIMARY KEY, comicInfoId INTEGER, parentId INTEGER, fileName TEXT, path TEXT);
      CREATE TABLE comic_info (id INTEGER PRIMARY KEY, title TEXT, number TEXT, publisher TEXT, writer TEXT, series TEXT, read INTEGER);
      INSERT INTO folder VALUES (1, NULL, 'Odd', '/odd', 26), (2, NULL, 'Even', '/even', 26);`)
    const insertInfo = library.prepare('INSERT INTO comic_info VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertComic = library.prepare('INSERT INTO comic VALUES (?, ?, ?, ?, ?)')
    library.transaction(() => {
      for (let comicId = 1; comicId <= 52; comicId += 1) {
        insertInfo.run(1000 + comicId, `Comic ${comicId}`, String(comicId), comicId % 2 ? 'Other' : 'House', '', '', comicId % 2)
        insertComic.run(comicId, 1000 + comicId, comicId % 2 ? 1 : 2, `Comic ${comicId}.cbz`, `/comic/${String(comicId).padStart(3, '0')}`)
      }
    })()
    enrichment.exec('CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL)')
    harness = createHarness({
      openLibrary: () => new Database(libraryPath, { readonly: true, fileMustExist: true }),
      enrichmentDatabase: () => new Database(enrichmentPath),
      allComicsFolderId: 0, libraryRootFolderId: 1, defaultPageSize: 120, libraryPath,
      coverUrl: () => null,
    })
    const { loadLibrary } = harness
    const filters = { folderId: 0, page: 1, pageSize: 24, search: '', metadata: 'all', reading: 'all', publisher: 'all', gcdStatus: 'pending', sort: 'path' }
    assert.equal(loadLibrary(filters).total, 52)

    const compileOption = enrichment.pragma('compile_options').map((row) => row.compile_options).find((option) => option.startsWith('MAX_VARIABLE_NUMBER='))
    const variableLimit = compileOption ? Number(compileOption.split('=')[1]) : 32766
    const insertEnrichment = enrichment.prepare('INSERT INTO enrichment VALUES (?, ?)')
    enrichment.transaction(() => {
      insertEnrichment.run(1001, '{}')
      insertEnrichment.run(1003, '{}')
      for (let index = 0; index <= variableLimit; index += 1) insertEnrichment.run(10000 + index, '{}')
    })()
    assert.throws(() => library.prepare(`SELECT id FROM comic_info WHERE id NOT IN (${Array(variableLimit + 1).fill('?').join(', ')})`), /too many SQL variables/)

    const firstPage = loadLibrary(filters)
    assert.equal(firstPage.total, 50)
    assert.deepEqual(Array.from(firstPage.comics, (comic) => comic.id), [2, ...Array.from({ length: 23 }, (_, index) => index + 4)])
    const lastPage = loadLibrary({ ...filters, page: 3 })
    assert.equal(lastPage.total, 50)
    assert.equal(lastPage.page, 3)
    assert.deepEqual(Array.from(lastPage.comics, (comic) => comic.id), [51, 52])
    const folder = loadLibrary({ ...filters, folderId: 1 })
    assert.equal(folder.total, 24)
    assert.ok(folder.comics.every((comic) => comic.id % 2 && comic.id > 3))
    const combined = loadLibrary({ ...filters, folderId: 2, search: 'Comic 2', metadata: 'complete', reading: 'unread', publisher: 'House' })
    assert.equal(combined.total, 6)
    assert.deepEqual(Array.from(combined.comics, (comic) => comic.id), [2, 20, 22, 24, 26, 28])
    assert.equal(loadLibrary({ ...filters, gcdStatus: 'all' }).total, 52)
    assert.equal(library.prepare('SELECT COUNT(*) AS total FROM comic_info').get().total, 52)
    assert.equal(enrichment.prepare('SELECT COUNT(*) AS total FROM enrichment').get().total, variableLimit + 3)
  } finally {
    harness?.close()
    library.close()
    enrichment.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('page reads reuse queries and sorted IDs while external library and proposal commits stay visible', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const directory = mkdtempSync(path.join(tmpdir(), 'yac-library-cache-'))
  const libraryPath = path.join(directory, 'library.ydb')
  const enrichmentPath = path.join(directory, "enrichment's.db")
  const library = new Database(libraryPath)
  const enrichment = new Database(enrichmentPath)
  const connections = []
  const queries = []
  const prepared = []
  let enrichmentOpens = 0
  let harness
  try {
    library.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE folder (id INTEGER PRIMARY KEY, parentId INTEGER, name TEXT, path TEXT, numChildren INTEGER);
      CREATE TABLE comic (id INTEGER PRIMARY KEY, comicInfoId INTEGER, parentId INTEGER, fileName TEXT, path TEXT);
      CREATE TABLE comic_info (id INTEGER PRIMARY KEY, title TEXT, number TEXT, publisher TEXT, writer TEXT, series TEXT, read INTEGER);
      INSERT INTO folder VALUES (1, NULL, 'Library', '/', 52);`)
    const insertInfo = library.prepare('INSERT INTO comic_info VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertComic = library.prepare('INSERT INTO comic VALUES (?, ?, ?, ?, ?)')
    library.transaction(() => {
      for (let id = 1; id <= 52; id += 1) {
        insertInfo.run(1000 + id, id === 25 ? null : `Comic ${id}`, String(id), 'Publisher', '', 'Series', 0)
        insertComic.run(id, 1000 + id, 1, `Comic ${id}.cbz`, `/comic/${id}`)
      }
    })()
    enrichment.exec('PRAGMA journal_mode = WAL; CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL)')
    const save = enrichment.prepare('INSERT OR REPLACE INTO enrichment VALUES (?, ?)')
    save.run(1001, '{"title":"First proposal"}')
    save.run(1025, '{"title":"Pending title","script":"Pending writer"}')
    save.run(9999, 'malformed proposal outside the library')
    harness = createHarness({
      openLibrary: () => {
        const connection = new Database(libraryPath, { readonly: true, fileMustExist: true, verbose: (sql) => queries.push(sql) })
        const prepare = connection.prepare.bind(connection)
        connection.prepare = (sql) => { prepared.push(sql); return prepare(sql) }
        connections.push(connection)
        return connection
      },
      enrichmentDatabase: () => { enrichmentOpens += 1; return new Database(enrichmentPath) },
      libraryPath, coverUrl: () => null,
    })
    const { loadLibrary } = harness
    const filters = { folderId: 0, page: 1, pageSize: 24, search: '', metadata: 'all', reading: 'all', publisher: 'all', gcdStatus: 'all', sort: 'number' }
    const sortedQueries = () => queries.filter((sql) => sql.includes(' AS sortValue'))
    const first = loadLibrary(filters)
    assert.equal(first.total, 52)
    assert.equal(first.comics[0].proposedFields.title, 'First proposal')
    assert.equal(sortedQueries().length, 1)
    assert.ok(!queries.some((sql) => sql.includes('COUNT(*)')))
    queries.length = 0
    const second = loadLibrary({ ...filters, page: 2 })
    assert.deepEqual(Array.from(second.comics, (comic) => comic.id), Array.from({ length: 24 }, (_, index) => index + 25))
    assert.deepEqual({ ...second.comics[0].pendingFields }, { title: 'Pending title', script: 'Pending writer' })
    assert.equal(sortedQueries().length, 0)
    assert.ok(!queries.some((sql) => /FROM folder|DISTINCT publisher|table_info|ATTACH/.test(sql)))
    assert.equal(prepared.filter((sql) => sql.includes('LEFT JOIN gcd_enrichment.enrichment')).length, 1)
    assert.equal(connections.length, 1)
    assert.equal(enrichmentOpens, 1)
    assert.equal(connections[0].readonly, true)

    library.transaction(() => {
      library.prepare("UPDATE comic_info SET number = '0', publisher = 'New publisher' WHERE id = 1052").run()
      library.prepare("UPDATE folder SET name = 'Renamed' WHERE id = 1").run()
    })()
    const changed = loadLibrary(filters)
    assert.equal(changed.comics[0].id, 52)
    assert.ok(changed.publishers.includes('New publisher'))
    assert.equal(changed.folders[0].name, 'Renamed')
    assert.equal(sortedQueries().length, 1)

    library.transaction(() => {
      insertInfo.run(1053, 'Comic 53', '53', 'Publisher', '', 'Series', 0)
      insertComic.run(53, 1053, 1, 'Comic 53.cbz', '/comic/53')
    })()
    const lastPage = loadLibrary({ ...filters, page: 99 })
    assert.equal(lastPage.total, 53)
    assert.equal(lastPage.page, 3)
    assert.deepEqual(Array.from(lastPage.comics, (comic) => comic.id), [48, 49, 50, 51, 53])
    library.prepare('DELETE FROM comic WHERE id = 53').run()
    assert.equal(loadLibrary(filters).total, 52)

    queries.length = 0
    save.run(1001, '{"title":"Updated proposal"}')
    const updatedProposal = loadLibrary(filters).comics.find((comic) => comic.id === 1)
    assert.equal(updatedProposal.proposedFields.title, 'Updated proposal')
    assert.equal(sortedQueries().length, 0)
    const pendingFilters = { ...filters, gcdStatus: 'pending' }
    assert.equal(loadLibrary(pendingFilters).total, 50)
    queries.length = 0
    save.run(1002, '{}')
    const newlyEnriched = loadLibrary(pendingFilters)
    assert.equal(newlyEnriched.total, 49)
    assert.ok(!newlyEnriched.comics.some((comic) => comic.id === 2))
    assert.equal(sortedQueries().length, 1)
    enrichment.prepare('DELETE FROM enrichment WHERE comic_info_id = 1001').run()
    const removedProposal = loadLibrary(pendingFilters)
    assert.equal(removedProposal.total, 50)
    assert.ok(removedProposal.comics.some((comic) => comic.id === 1))
    queries.length = 0
    loadLibrary({ ...pendingFilters, page: 2 })
    assert.equal(sortedQueries().length, 0)

    const empty = loadLibrary({ ...filters, search: 'No matching comic', page: 99 })
    assert.equal(empty.total, 0)
    assert.equal(empty.page, 1)
    assert.equal(empty.comics.length, 0)
    harness.close()
    harness.close()
    assert.equal(connections[0].open, false)
    assert.equal(loadLibrary(filters).total, 52)
    assert.equal(connections.length, 2)
  } finally {
    harness?.close()
    library.close()
    enrichment.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('replacing either database reopens the reader and failed initialisation releases its connection', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const directory = mkdtempSync(path.join(tmpdir(), 'yac-library-replace-'))
  const libraryPath = path.join(directory, 'library.ydb')
  const enrichmentPath = path.join(directory, 'enrichment.db')
  const connections = []
  let failEnrichment = true
  const reader = createLibraryReader({
    libraryPath,
    openLibrary: () => {
      const connection = new Database(libraryPath, { readonly: true, fileMustExist: true })
      connections.push(connection)
      return connection
    },
    enrichmentDatabase: () => {
      if (failEnrichment) throw new Error('Proposal database unavailable')
      return new Database(enrichmentPath, { fileMustExist: true })
    },
  })
  const createLibrary = (filePath, title) => {
    const database = new Database(filePath)
    try {
      database.exec(`CREATE TABLE folder (id INTEGER PRIMARY KEY, parentId INTEGER, name TEXT, path TEXT, numChildren INTEGER);
        CREATE TABLE comic (id INTEGER PRIMARY KEY, comicInfoId INTEGER, parentId INTEGER, fileName TEXT, path TEXT);
        CREATE TABLE comic_info (id INTEGER PRIMARY KEY, title TEXT, publisher TEXT);
        INSERT INTO folder VALUES (1, NULL, 'Library', '/', 1);
        INSERT INTO comic VALUES (1, 1001, 1, 'Comic.cbz', '/comic');`)
      database.prepare('INSERT INTO comic_info VALUES (1001, ?, ?)').run(title, 'Publisher')
    } finally { database.close() }
  }
  const createEnrichment = (filePath, title) => {
    const database = new Database(filePath)
    try {
      database.exec('CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL)')
      database.prepare('INSERT INTO enrichment VALUES (1001, ?)').run(JSON.stringify({ title }))
    } finally { database.close() }
  }
  try {
    createLibrary(libraryPath, 'Original comic')
    createEnrichment(enrichmentPath, 'Original proposal')
    const filters = { folderId: 0, page: 1, pageSize: 24, sort: 'title' }
    assert.throws(() => reader.load(filters), /Proposal database unavailable/)
    assert.equal(connections[0].open, false)
    failEnrichment = false
    assert.equal(reader.load(filters).comics[0].title, 'Original comic')
    const replacementLibrary = path.join(directory, 'replacement.ydb')
    createLibrary(replacementLibrary, 'Replacement comic')
    renameSync(replacementLibrary, libraryPath)
    assert.equal(reader.load(filters).comics[0].title, 'Replacement comic')
    assert.equal(connections[1].open, false)
    const replacementEnrichment = path.join(directory, 'replacement.db')
    createEnrichment(replacementEnrichment, 'Replacement proposal')
    renameSync(replacementEnrichment, enrichmentPath)
    assert.equal(reader.load(filters).comics[0].proposedFields.title, 'Replacement proposal')
    assert.equal(connections[2].open, false)
  } finally {
    reader.close()
    rmSync(directory, { recursive: true, force: true })
  }
})