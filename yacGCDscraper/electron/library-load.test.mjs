import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
const implementation = source.slice(source.indexOf('function loadLibrary('), source.indexOf('function getComicMetadata('))

test('GCD status filtering handles enrichment beyond the SQL variable limit without changing library data', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const directory = mkdtempSync(path.join(tmpdir(), 'yac-library-load-'))
  const libraryPath = path.join(directory, 'library.ydb')
  const enrichmentPath = path.join(directory, "enrichment's.db")
  const library = new Database(libraryPath)
  const enrichment = new Database(enrichmentPath)
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
    const loadLibrary = runInNewContext(`${implementation}\nloadLibrary`, {
      openLibrary: () => new Database(libraryPath, { readonly: true, fileMustExist: true }),
      enrichmentDatabase: () => new Database(enrichmentPath),
      allComicsFolderId: 0, libraryRootFolderId: 1, defaultPageSize: 120, libraryPath,
      yacReaderMappings: {}, coverUrl: () => null,
    })
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
    library.close()
    enrichment.close()
    rmSync(directory, { recursive: true, force: true })
  }
})