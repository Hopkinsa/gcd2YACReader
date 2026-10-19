import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { applyGcdSyncChanges, buildGcdSyncPlan, extractGcdFields, fieldsFromMatch, gcdSyncChanges, listGcdProposals, persistGcdLinks, removeGcdProposals, resolveGcdSyncCandidate, saveGcdProposal, yacReaderMappings } from './gcd-sync.mjs'
import { browseGcdRecords, createGcdMappings } from './mapping-browser.mjs'

const mappings = { series: 'series', script: 'writer', storySynopsis: 'synopsis' }
const columns = new Set(['series', 'writer'])

test('proposal removal deletes only selected records and the refreshed list retains unchecked proposals', () => {
  const rows = new Map([1, 2, 3].map((comicInfoId) => [comicInfoId, { comicInfoId, fields: JSON.stringify({ gcdIssueId: String(comicInfoId), title: `Comic ${comicInfoId}` }), updatedAt: '2026-10-12' }]))
  let transactions = 0
  const database = {
    prepare: (sql) => sql.startsWith('SELECT') ? { all: () => [...rows.values()] } : {
      run: (comicInfoId) => ({ changes: rows.delete(comicInfoId) ? 1 : 0 }),
    },
    transaction: (callback) => () => { transactions += 1; return callback() },
  }
  assert.equal(listGcdProposals(database).length, 3)
  assert.equal(removeGcdProposals(database, [1, 1, 3, 99]), 2)
  assert.equal(transactions, 1)
  assert.deepEqual(listGcdProposals(database), [{ comicInfoId: 2, fields: { gcdIssueId: '2', title: 'Comic 2' }, updatedAt: '2026-10-12' }])
  for (const invalid of [null, '2', [2, -1], [2, '3'], [2, 1.5], [2, Number.MAX_SAFE_INTEGER + 1]]) assert.throws(() => removeGcdProposals(database, invalid), /valid proposal IDs/)
  assert.equal(rows.has(2), true)
  assert.equal(removeGcdProposals(database, []), 0)
  assert.equal(removeGcdProposals(database, [2]), 1)
  assert.deepEqual(listGcdProposals(database), [])
})

test('proposal listing batches library lookups and preserves ordering, first comic, and missing records', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  const library = new Database(':memory:')
  try {
    database.exec('CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    library.exec(`CREATE TABLE comic (id INTEGER PRIMARY KEY, comicInfoId INTEGER, fileName TEXT, path TEXT);
      CREATE TABLE comic_info (id INTEGER PRIMARY KEY, title TEXT);
      INSERT INTO comic VALUES (3, 10, 'later.cbz', '/later'), (1, 10, 'first.cbz', '/first'),
        (2, 20, 'second.cbz', '/second'), (4, 30, 'orphan.cbz', '/orphan');
      INSERT INTO comic_info VALUES (10, 'First title'), (20, 'Second title');`)
    for (const comicInfoId of [10, 20, 30, 99]) saveGcdProposal(database, comicInfoId, { title: `Proposal ${comicInfoId}` })
    database.prepare("UPDATE enrichment SET updated_at = '2099-01-01' WHERE comic_info_id = 20").run()
    let lookups = 0
    const countedLibrary = { prepare: (sql) => { lookups += 1; return library.prepare(sql) } }
    const original = library.prepare('SELECT c.fileName, c.path, ci.title FROM comic c LEFT JOIN comic_info ci ON ci.id = c.comicInfoId WHERE c.comicInfoId = ? ORDER BY c.id LIMIT 1')
    const expected = listGcdProposals(database).map((proposal) => ({ ...proposal, ...original.get(proposal.comicInfoId) }))
    assert.deepEqual(listGcdProposals(database, countedLibrary), expected)
    assert.equal(lookups, 1)
    assert.equal(expected[0].comicInfoId, 20)
    assert.equal(expected[1].fileName, 'first.cbz')
    database.exec('DELETE FROM enrichment')
    assert.deepEqual(listGcdProposals(database, countedLibrary), [])
    assert.equal(lookups, 1)
  } finally { library.close(); database.close() }
})

test('proposal deletion is transactional in SQLite and leaves library metadata unchanged', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec(`CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE comic_info (id INTEGER PRIMARY KEY, title TEXT);
      INSERT INTO comic_info VALUES (1, 'Manual title');`)
    for (const comicInfoId of [1, 2, 3]) saveGcdProposal(database, comicInfoId, { gcdIssueId: String(comicInfoId), title: `Proposal ${comicInfoId}` })
    assert.deepEqual(listGcdProposals(database).map((proposal) => proposal.comicInfoId), [1, 2, 3])
    database.exec("CREATE TRIGGER protect_proposal BEFORE DELETE ON enrichment WHEN OLD.comic_info_id = 2 BEGIN SELECT RAISE(ABORT, 'Deletion blocked'); END;")
    assert.throws(() => removeGcdProposals(database, [1, 2]), /Deletion blocked/)
    assert.equal(listGcdProposals(database).length, 3)
    database.exec('DROP TRIGGER protect_proposal')
    assert.equal(removeGcdProposals(database, [1, 3]), 2)
    assert.deepEqual(listGcdProposals(database).map((proposal) => proposal.fields), [{ gcdIssueId: '2', title: 'Proposal 2' }])
    assert.equal(database.prepare('SELECT title FROM comic_info WHERE id = 1').get().title, 'Manual title')
  } finally { database.close() }
})

test('GCD dates use the first of a known month and June 30 for year-only values', () => {
  for (const [input, expected] of [
    ['2020', '30/06/2020'], ['2020-00-00', '30/06/2020'],
    ['2020-02', '01/02/2020'], ['02/2020', '01/02/2020'], ['2-2020', '01/02/2020'], ['2020/2', '01/02/2020'], ['2020-02-00', '01/02/2020'],
    ['February 2020', '01/02/2020'], ['feb 2020', '01/02/2020'], ['Sept. 2020', '01/09/2020'], ['December, 2020', '01/12/2020'],
    ['2020-02-29', '2020-02-29'], ['29/02/2020', '29/02/2020'], ['February 29, 2020', 'February 29, 2020'],
    ['[2020]', '30/06/2020'], ['[02/2020]', '01/02/2020'], ['[February] [2020]', '01/02/2020'],
    ['[2020-02-29]', '2020-02-29'], ['29/[02]/2020', '29/02/2020'], [' [February 29, 2020] ', 'February 29, 2020'], ['[]', ''],
    ['13/2020', '13/2020'], ['Unknown 2020', 'Unknown 2020'], ['', ''],
  ]) {
    assert.equal(fieldsFromMatch({ id: 1, onSaleDate: input }).onSaleDate, expected, input)
    assert.equal(fieldsFromMatch({ id: 1, publicationDate: input }).onSaleDate, expected, `Publication date: ${input}`)
  }
  assert.equal(fieldsFromMatch({ id: 1, onSaleDate: '2020-02-29', publicationDate: 'March 2020' }).onSaleDate, '2020-02-29')
})

test('GCD extraction combines all stories, issue notes, and publication metadata', () => {
  const fields = fieldsFromMatch({ id: 42, number: '001', seriesName: 'Series', issueCount: 12,
    seriesFormat: 'Comic book', rating: 'Teen', languageISO: 'en', issueNotes: 'Issue notes', editing: 'Editor (editor)',
    crossoverArc: 'Arc', crossoverPart: '2', arcCount: '4',
    stories: [
      { id: 1, type: 'cover', script: 'Writer A', pencils: 'Artist A', inks: 'Artist A', notes: 'Cover notes', editing: 'Editor' },
      { id: 2, type: 'comic story', script: 'Writer A; Writer B', pencils: 'Artist B', genre: 'Adventure', characters: 'Hero', synopsis: 'First plot', notes: 'First notes' },
      { id: 3, type: 'comic story', script: 'Writer C', genre: 'Adventure; Fantasy', characters: 'Guest', synopsis: 'Second plot', notes: 'Issue notes' },
      { id: 4, type: 'cover', pencils: 'Artist C', inks: 'Artist D' },
    ] })
  assert.equal(fields.issueNumber, '1')
  assert.equal(fields.script, 'Writer A; Writer B; Writer C')
  assert.equal(fields.pencils, 'Artist A; Artist B; Artist C')
  assert.equal(fields.coverArtist, 'Artist A; Artist C; Artist D')
  assert.equal(fields.storyGenre, 'Adventure; Fantasy')
  assert.equal(fields.storyCharacters, 'Hero\n\nGuest')
  assert.equal(fields.storySynopsis, 'First plot\n\nSecond plot')
  assert.equal(fields.storyNotes, 'Issue notes\n\nCover notes\n\nFirst notes')
  assert.equal(fields.editor, 'Editor')
  assert.equal(fields.issueCount, '12')
  assert.equal(fields.format, 'Comic book')
  assert.equal(fields.ageRating, 'Teen')
  assert.equal(fields.languageISO, 'en')
  assert.equal(fields.crossoverArc, 'Arc')
  assert.equal(fields.crossoverPart, '2')
  assert.equal(fields.arcCount, '4')
})

test('GCD extraction leaves unavailable metadata blank instead of guessing', () => {
  const fields = fieldsFromMatch({ id: 1, number: '[nn]', stories: [{ type: 'comic story', title: 'Part 3', sequenceNumber: 3 }] })
  for (const field of ['issueNumber', 'issueCount', 'crossoverArc', 'crossoverPart', 'arcCount', 'alternateSeries', 'alternateNumber', 'alternateCount', 'seriesGroup', 'teams', 'locations', 'mainCharacterOrTeam', 'review', 'tags']) assert.equal(fields[field], '')
})

test('sync separates missing and differing fields and ignores empty source values', async () => {
  const comic = { comicInfoId: 1, fileName: 'Comic 1.cbz', series: 'Manual series', writer: null }
  const plan = await buildGcdSyncPlan({ comics: [comic], mappings, columns, resolveFields: () => ({ series: 'GCD series', script: 'GCD writer', storySynopsis: 'Plot' }) })
  assert.equal(plan.matched, 1)
  assert.equal(plan.skippedUnsupported, 1)
  assert.deepEqual(plan.missingChanges, [{ comicInfoId: 1, fileName: 'Comic 1.cbz', enrichmentField: 'script', libraryField: 'writer', previousValue: null, value: 'GCD writer' }])
  assert.equal(plan.differingChanges.length, 1)
  assert.equal(plan.differingChanges[0].previousValue, 'Manual series')
  const emptyPlan = await buildGcdSyncPlan({ comics: [comic], mappings, columns, resolveFields: () => ({ series: '', script: '  ' }) })
  assert.deepEqual(emptyPlan.missingChanges, [])
  assert.deepEqual(emptyPlan.differingChanges, [])
})

test('sync ignores identical values, treats whitespace as missing, and preserves numeric old values', async () => {
  const plan = await buildGcdSyncPlan({
    comics: [{ comicInfoId: 2, fileName: 'Comic 2.cbz', series: 'Same', writer: '  ', number: 2 }],
    mappings: { ...mappings, issueNumber: 'number' }, columns: new Set([...columns, 'number']),
    resolveFields: () => ({ series: 'Same', script: 'Writer', issueNumber: '3' }),
  })
  assert.equal(plan.missingChanges.length, 1)
  assert.equal(plan.missingChanges[0].previousValue, '  ')
  assert.equal(plan.differingChanges.length, 1)
  assert.equal(plan.differingChanges[0].previousValue, 2)
})

test('sync skips unresolved matches and reports per-record failures without stopping traversal', async () => {
  const progress = []
  const plan = await buildGcdSyncPlan({
    comics: [1, 2, 3].map((comicInfoId) => ({ comicInfoId, fileName: `${comicInfoId}.cbz` })), mappings, columns,
    resolveFields: (comic) => { if (comic.comicInfoId === 1) throw new Error('Invalid comic'); return comic.comicInfoId === 2 ? null : { script: 'Writer' } },
    onProgress: (value) => progress.push(value),
  })
  assert.equal(plan.scanned, 3)
  assert.equal(plan.matched, 1)
  assert.equal(plan.unmatched, 2)
  assert.equal(plan.failed, 1)
  assert.equal(progress.at(-1).scanned, 3)
})

test('existing values require an explicit replacement opt-in', () => {
  const plan = { missingChanges: [{ value: 'Missing' }], differingChanges: [{ value: 'Replacement' }] }
  assert.deepEqual(gcdSyncChanges(plan), plan.missingChanges)
  assert.deepEqual(gcdSyncChanges(plan, 'true'), plan.missingChanges)
  assert.deepEqual(gcdSyncChanges(plan, true), [...plan.missingChanges, ...plan.differingChanges])
})

test('saved IDs take precedence and deleted or invalid IDs never fall back to matching', () => {
  const linked = { id: 42 }
  const lookups = { findById: (issueId) => issueId === 42 ? linked : null, findCandidates: () => { throw new Error('Must not rematch'); } }
  assert.equal(resolveGcdSyncCandidate('42', lookups), linked)
  assert.equal(resolveGcdSyncCandidate('43', lookups), null)
  assert.equal(resolveGcdSyncCandidate('invalid', lookups), null)
})

test('unlinked comics require exactly one score-100 match', () => {
  const exact = { id: 1, score: 100 }
  const resolve = (matches) => resolveGcdSyncCandidate(null, { findById: () => { throw new Error('No saved ID'); }, findCandidates: () => matches })
  assert.equal(resolve([exact, { id: 2, score: 90 }]), exact)
  assert.equal(resolve([exact, { id: 2, score: 100 }]), null)
  assert.equal(resolve([{ id: 2, score: 90 }]), null)
})

test('structured GCD metadata is aggregated and written through the expanded mapping', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec(`CREATE TABLE gcd_issue (id INTEGER, series_id INTEGER, key_date TEXT, sort_code INTEGER, variant_of_id INTEGER, deleted INTEGER);
      CREATE TABLE gcd_series (id INTEGER, issue_count INTEGER, language_id INTEGER, publishing_format TEXT);
      CREATE TABLE stddata_language (id INTEGER, code TEXT);
      CREATE TABLE gcd_story (id INTEGER, issue_id INTEGER, deleted INTEGER);
      CREATE TABLE gcd_story_arc (id INTEGER, name TEXT, deleted INTEGER);
      CREATE TABLE gcd_story_story_arc (id INTEGER, story_id INTEGER, storyarc_id INTEGER);
      CREATE TABLE gcd_story_credit (id INTEGER, story_id INTEGER, credit_type_id INTEGER, creator_id INTEGER, credit_name TEXT, deleted INTEGER);
      CREATE TABLE gcd_credit_type (id INTEGER, name TEXT);
      CREATE TABLE gcd_creator_name_detail (id INTEGER, name TEXT, deleted INTEGER);
      CREATE TABLE gcd_character (id INTEGER, name TEXT, deleted INTEGER);
      CREATE TABLE gcd_character_role (id INTEGER, name TEXT);
      CREATE TABLE gcd_story_character (id INTEGER, story_id INTEGER, character_id INTEGER, role_id INTEGER, deleted INTEGER);
      CREATE TABLE gcd_group (id INTEGER, name TEXT, deleted INTEGER);
      CREATE TABLE gcd_story_character_group (id INTEGER, storycharacter_id INTEGER, group_id INTEGER);
      CREATE TABLE taggit_tag (id INTEGER, name TEXT);
      CREATE TABLE taggit_taggeditem (tag_id INTEGER, object_id INTEGER, content_type_id INTEGER);
      CREATE TABLE django_content_type (id INTEGER, app_label TEXT, model TEXT);
      INSERT INTO gcd_issue VALUES (42, 1, '2020-02-00', 2, NULL, 0), (41, 1, '2020-01-00', 1, NULL, 0), (43, 1, '2020-03-00', 3, NULL, 1), (44, 1, '2020-02-00', 4, 42, 0);
      INSERT INTO gcd_series VALUES (1, 12, 25, 'Comic book');
      INSERT INTO stddata_language VALUES (25, 'en');
      INSERT INTO gcd_story VALUES (1, 42, 0), (2, 42, 0), (3, 41, 0), (4, 43, 0), (5, 44, 0), (6, 42, 1);
      INSERT INTO gcd_story_arc VALUES (1, 'Arc', 0), (2, 'Deleted arc', 1);
      INSERT INTO gcd_story_story_arc VALUES (1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 4, 1), (5, 5, 1), (6, 1, 2);
      INSERT INTO gcd_credit_type VALUES (1, 'script'), (2, 'pencils and inks'), (3, 'script, pencils, and inks');
      INSERT INTO gcd_creator_name_detail VALUES (1, 'Writer', 0), (2, 'Artist', 0), (3, 'Other writer', 0);
      INSERT INTO gcd_story_credit VALUES (1, 1, 1, 1, '', 0), (2, 2, 2, 2, '', 0), (3, 2, 1, 3, 'Printed name', 0), (4, 2, 1, 3, 'Deleted', 1), (5, 6, 1, 3, 'Deleted story', 0), (6, 2, 3, 2, '', 0);
      INSERT INTO gcd_character_role VALUES (1, 'featured'), (2, 'guest');
      INSERT INTO gcd_character VALUES (1, 'Hero', 0), (2, 'Guest', 0), (3, 'Deleted character', 1);
      INSERT INTO gcd_story_character VALUES (1, 1, 1, 1, 0), (2, 2, 2, 2, 0), (3, 2, 3, 1, 0);
      INSERT INTO gcd_group VALUES (1, 'Team', 0), (2, 'Guest team', 0), (3, 'Deleted team', 1);
      INSERT INTO gcd_story_character_group VALUES (1, 1, 1), (2, 2, 2), (3, 1, 3);
      INSERT INTO django_content_type VALUES (1, 'gcd', 'issue'), (2, 'gcd', 'series'), (3, 'gcd', 'story'), (4, 'other', 'issue');
      INSERT INTO taggit_tag VALUES (1, 'Issue tag'), (2, 'Series tag'), (3, 'Story tag'), (4, 'Excluded');
      INSERT INTO taggit_taggeditem VALUES (1, 42, 1), (2, 1, 2), (3, 2, 3), (1, 1, 3), (4, 6, 3), (4, 42, 4);`)
    const match = { id: 42, number: '2', seriesName: 'Series', seriesFormat: 'Comic book', rating: 'Teen', issueNotes: 'Issue note',
      stories: [{ id: 1, type: 'comic story', script: 'Legacy writer', notes: 'First note' }, { id: 2, type: 'cover', notes: 'Second note' }] }
    const fields = extractGcdFields(database, match)
    assert.equal(fields.issueCount, '12')
    assert.equal(fields.languageISO, 'en')
    assert.equal(fields.script, 'Legacy writer; Writer; Printed name; Artist')
    assert.equal(fields.coverArtist, 'Artist')
    assert.equal(fields.crossoverArc, 'Arc')
    assert.equal(fields.crossoverPart, '2')
    assert.equal(fields.arcCount, '2')
    assert.equal(fields.storyCharacters, 'Hero\n\nGuest')
    assert.equal(fields.teams, 'Team; Guest team')
    assert.equal(fields.mainCharacterOrTeam, 'Hero; Team')
    assert.equal(fields.tags, 'Issue tag; Series tag; Story tag')
    assert.equal(fields.storyNotes, 'Issue note\n\nFirst note\n\nSecond note')
    assert.equal(extractGcdFields(database, { ...match, seriesFormat: '' }).format, 'Comic book')
    assert.deepEqual(extractGcdFields(database, match), fields)
    assert.equal(match.stories[0].script, 'Legacy writer')
    const libraryColumns = new Set(Object.values(yacReaderMappings))
    database.exec(`CREATE TABLE comic_info (id INTEGER PRIMARY KEY, ${[...libraryColumns].map((column) => `${column} TEXT`).join(', ')});
      INSERT INTO comic_info (id, format, review) VALUES (1, 'Manual format', 'Manual review');`)
    const comic = { ...database.prepare('SELECT * FROM comic_info').get(), comicInfoId: 1, fileName: 'Comic.cbz' }
    const plan = await buildGcdSyncPlan({ comics: [comic], columns: libraryColumns, mappings: yacReaderMappings, resolveFields: () => fields })
    applyGcdSyncChanges(database, gcdSyncChanges(plan), yacReaderMappings)
    const saved = database.prepare('SELECT * FROM comic_info').get()
    assert.equal(saved.count, '12')
    assert.equal(saved.storyArc, 'Arc')
    assert.equal(saved.arcNumber, '2')
    assert.equal(saved.arcCount, '2')
    assert.equal(saved.teams, 'Team; Guest team')
    assert.equal(saved.ageRating, 'Teen')
    assert.equal(saved.languageISO, 'en')
    assert.equal(saved.notes, fields.storyNotes)
    assert.equal(saved.tags, fields.tags)
    assert.equal(saved.format, 'Manual format')
    assert.equal(saved.review, 'Manual review')
    applyGcdSyncChanges(database, plan.differingChanges, yacReaderMappings)
    assert.equal(database.prepare('SELECT format FROM comic_info').get().format, 'Comic book')
    database.exec('INSERT INTO gcd_story_arc VALUES (3, \'Second arc\', 0); INSERT INTO gcd_story_story_arc VALUES (7, 1, 3);')
    const multipleArcs = extractGcdFields(database, match)
    assert.equal(multipleArcs.crossoverArc, 'Arc; Second arc')
    assert.equal(multipleArcs.crossoverPart, '')
    assert.equal(multipleArcs.arcCount, '')
  } finally { database.close() }
})

test('older GCD schemas without optional metadata tables still extract story values', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec('CREATE TABLE gcd_issue (id INTEGER, series_id INTEGER); CREATE TABLE gcd_series (id INTEGER); INSERT INTO gcd_issue VALUES (1, 1);')
    const fields = extractGcdFields(database, { id: 1, stories: [{ script: 'Writer', synopsis: 'Plot' }] })
    assert.equal(fields.script, 'Writer')
    assert.equal(fields.storySynopsis, 'Plot')
    assert.equal(fields.languageISO, '')
    assert.equal(fields.crossoverArc, '')
  } finally { database.close() }
})

test('sync persists confirmed links even when metadata is unchanged and preserves proposals', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec(`CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    database.prepare('INSERT INTO enrichment (comic_info_id, fields_json) VALUES (?, ?)').run(2, JSON.stringify({ series: 'Manual proposal', custom: 'Keep' }))
    const plan = await buildGcdSyncPlan({
      comics: [1, 2, 3, 4].map((comicInfoId) => ({ comicInfoId, series: 'Same' })), mappings: { series: 'series' }, columns: new Set(['series']),
      resolveFields: (comic) => {
        if (comic.comicInfoId === 4) throw new Error('Failed match')
        return comic.comicInfoId === 3 ? null : { series: 'Same', gcdIssueId: String(40 + comic.comicInfoId) }
      },
    })
    assert.deepEqual(plan.missingChanges, [])
    assert.deepEqual(plan.differingChanges, [])
    assert.deepEqual(plan.matchedLinks, [{ comicInfoId: 1, gcdIssueId: '41' }, { comicInfoId: 2, gcdIssueId: '42' }])
    assert.equal(persistGcdLinks(database, plan.matchedLinks), 2)
    const readFields = (comicInfoId) => JSON.parse(database.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = ?').get(comicInfoId).fields_json)
    assert.equal(readFields(1).gcdIssueId, '41')
    assert.deepEqual(readFields(2), { series: 'Manual proposal', custom: 'Keep', gcdIssueId: '42' })
    assert.equal(persistGcdLinks(database, plan.matchedLinks), 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enrichment').get().count, 2)
    assert.throws(() => persistGcdLinks(database, [{ comicInfoId: 5, gcdIssueId: '45' }, { comicInfoId: 2, gcdIssueId: '99' }]), /link changed/)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enrichment').get().count, 2)
    assert.equal(readFields(2).gcdIssueId, '42')
    assert.throws(() => persistGcdLinks(database, [{ comicInfoId: 5, gcdIssueId: 'invalid' }]), /Invalid GCD link/)
  } finally { database.close() }
})

test('manual, automatic, and sync links survive reopening and later proposal edits', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const directory = mkdtempSync(path.join(tmpdir(), 'yac-gcd-links-'))
  const databasePath = path.join(directory, 'enrichment.db')
  let database
  try {
    database = new Database(databasePath)
    database.exec('CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    saveGcdProposal(database, 1, fieldsFromMatch({ id: 41, seriesName: 'Manual match' }))
    database.transaction(() => saveGcdProposal(database, 2, fieldsFromMatch({ id: 42, seriesName: 'Automatic match' })))()
    persistGcdLinks(database, [{ comicInfoId: 3, gcdIssueId: '43' }])
    database.close()
    database = new Database(databasePath)
    const readFields = (comicInfoId) => JSON.parse(database.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = ?').get(comicInfoId).fields_json)
    for (const comicInfoId of [1, 2, 3]) {
      assert.equal(readFields(comicInfoId).gcdIssueId, String(40 + comicInfoId))
      saveGcdProposal(database, comicInfoId, { series: 'Edited proposal' })
      assert.equal(readFields(comicInfoId).gcdIssueId, String(40 + comicInfoId))
      assert.equal(readFields(comicInfoId).series, 'Edited proposal')
    }
    saveGcdProposal(database, 1, fieldsFromMatch({ id: 99, seriesName: 'Explicit replacement match' }))
    assert.equal(readFields(1).gcdIssueId, '99')
    database.close()
    database = new Database(databasePath, { readonly: true })
    assert.equal(readFields(1).gcdIssueId, '99')
    assert.equal(readFields(2).gcdIssueId, '42')
    assert.equal(readFields(3).gcdIssueId, '43')
  } finally {
    if (database?.open) database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('manual folder mappings save proposals and skip ambiguous, existing, and unmatched issues', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec(`CREATE TABLE comic (id INTEGER, parentId INTEGER, comicInfoId INTEGER, fileName TEXT, path TEXT);
      CREATE TABLE comic_info (id INTEGER, number TEXT, title TEXT);
      CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE gcd_issue (id INTEGER, series_id INTEGER, number TEXT, variant_of_id INTEGER, deleted INTEGER, sort_code INTEGER, title TEXT, variant_name TEXT, indicia_publisher_id INTEGER, on_sale_date TEXT);
      CREATE TABLE gcd_series (id INTEGER, publisher_id INTEGER, name TEXT, year_began INTEGER, deleted INTEGER);
      CREATE TABLE gcd_publisher (id INTEGER, name TEXT, deleted INTEGER);
      CREATE TABLE gcd_indicia_publisher (id INTEGER, name TEXT);
      INSERT INTO comic_info VALUES (1, '1', 'Anchor'), (2, '002', 'Second'), (3, '3', 'Ambiguous'), (4, '4', 'Existing'), (5, '5', 'Unmatched'), (6, '2', 'Other folder');
      INSERT INTO comic VALUES (10, 1, 1, 'Anchor.cbz', '/Anchor.cbz'), (20, 1, 2, 'Second.cbz', '/Second.cbz'), (30, 1, 3, 'Ambiguous.cbz', '/Ambiguous.cbz'), (40, 1, 4, 'Existing.cbz', '/Existing.cbz'), (50, 1, 5, 'Unmatched.cbz', '/Unmatched.cbz'), (60, 2, 6, 'Other.cbz', '/Other.cbz');
      INSERT INTO gcd_series VALUES (1, 1, 'Series', 2020, 0), (2, 1, 'Deleted', 2020, 1);
      INSERT INTO gcd_publisher VALUES (1, 'Publisher', 0);
      INSERT INTO gcd_issue (id, series_id, number, variant_of_id, deleted, sort_code) VALUES (41,1,'1',NULL,0,1),(42,1,'2',NULL,0,2),(142,1,'2',42,0,3),(43,1,'3',NULL,0,4),(143,1,'3',NULL,0,5),(44,1,'4',NULL,0,6),(45,1,'5',NULL,1,7);`)
    saveGcdProposal(database, 4, { gcdIssueId: '99', notes: 'Keep' })
    const options = { library: database, gcd: database, enrichment: database, comicId: 10, gcdIssueId: 41, resolveFields: (id) => ({ gcdIssueId: String(id), storySynopsis: `Plot ${id}`, series: 'Series' }) }
    await assert.rejects(createGcdMappings({ ...options, matchFolder: true }), /Save the selected mapping/)
    assert.equal((await createGcdMappings(options)).saved, 1)
    const read = (id) => JSON.parse(database.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = ?').get(id)?.fields_json || '{}')
    await assert.rejects(createGcdMappings({ ...options, matchFolder: true, selectedComicIds: [] }), /Select valid library entries/)
    await assert.rejects(createGcdMappings({ ...options, matchFolder: true, selectedComicIds: [20, '30'] }), /Select valid library entries/)
    const selected = await createGcdMappings({ ...options, matchFolder: true, selectedComicIds: [10, 20, 20, 60] })
    assert.deepEqual(selected, { scanned: 1, saved: 1, skippedExisting: 0, ambiguous: 0, unmatched: 0, failed: 0 })
    assert.equal(read(2).gcdIssueId, '42')
    assert.equal(read(3).gcdIssueId, undefined)
    assert.equal(read(4).gcdIssueId, '99')
    assert.equal(read(5).gcdIssueId, undefined)
    assert.equal(read(6).gcdIssueId, undefined)
    assert.equal((await createGcdMappings({ ...options, matchFolder: true, selectedComicIds: [20] })).skippedExisting, 1)
    database.prepare('DELETE FROM enrichment WHERE comic_info_id = ?').run(2)
    const result = await createGcdMappings({ ...options, matchFolder: true })
    assert.deepEqual(result, { scanned: 4, saved: 1, skippedExisting: 1, ambiguous: 1, unmatched: 1, failed: 0 })
    assert.equal(read(2).gcdIssueId, '42')
    assert.equal(read(2).storySynopsis, 'Plot 42')
    assert.equal(read(4).gcdIssueId, '99')
    assert.equal(read(6).gcdIssueId, undefined)
    assert.equal(database.prepare('SELECT title FROM comic_info WHERE id = 2').get().title, 'Second')
    assert.equal((await createGcdMappings({ ...options, matchFolder: true, overwriteExisting: true })).saved, 2)
    assert.equal(read(4).gcdIssueId, '44')
    assert.equal(browseGcdRecords(database).records[0].name, 'Publisher')
    assert.equal(browseGcdRecords(database, { publisherId: 1 }).records.length, 1)
    assert.equal(browseGcdRecords(database, { publisherId: 1 }).records[0].issueCount, 5)
    assert.equal(browseGcdRecords(database, { publisherId: 1, search: 'series' }).records[0].issueCount, 5)
    assert.equal(browseGcdRecords(database, { seriesId: 1, search: '2' }).records.length, 2)
    assert.equal(browseGcdRecords(database, { seriesId: 1, search: '%' }).records.length, 0)
    database.exec("UPDATE gcd_issue SET title = 'Distinctive Title 100%_complete' WHERE id = 42; UPDATE gcd_issue SET title = 'Deleted issue title' WHERE id = 45; INSERT INTO gcd_issue (id, series_id, number, deleted, sort_code, title) VALUES (46, 2, '1', 0, 1, 'Hidden series issue');")
    for (const search of ['publisher', 'series', 'distinctive title', '100%_complete']) {
      assert.deepEqual(browseGcdRecords(database, { search }).records.map((record) => record.id), [1])
      assert.deepEqual(browseGcdRecords(database, { publisherId: 1, search }).records.map((record) => record.id), [1])
      assert.ok(browseGcdRecords(database, { seriesId: 1, search }).records.some((record) => record.id === 42))
    }
    assert.deepEqual(browseGcdRecords(database, { seriesId: 1, search: 'distinctive title' }).records.map((record) => record.id), [42])
    for (const search of ['Deleted issue title', 'Hidden series issue', 'Missing title']) {
      assert.equal(browseGcdRecords(database, { search }).records.length, 0)
      assert.equal(browseGcdRecords(database, { publisherId: 1, search }).records.length, 0)
    }
    database.exec("INSERT INTO gcd_series VALUES (3, 1, 'Empty', 2021, 0)")
    assert.equal(browseGcdRecords(database, { publisherId: 1, search: 'Empty' }).records[0].issueCount, 0)
    assert.equal(browseGcdRecords(database, { publisherId: 1, search: 'distinctive title' }).records[0].issueCount, 5)
  } finally { database.close() }
})

test('GCD issue browsing sorts numerically before sort code and ID, including across pages', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec(`CREATE TABLE gcd_issue (id INTEGER PRIMARY KEY, series_id INTEGER, number TEXT, variant_of_id INTEGER, deleted INTEGER DEFAULT 0, sort_code INTEGER, title TEXT, variant_name TEXT, indicia_publisher_id INTEGER, on_sale_date TEXT);
      CREATE TABLE gcd_series (id INTEGER PRIMARY KEY, publisher_id INTEGER, name TEXT, deleted INTEGER);
      CREATE TABLE gcd_publisher (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE gcd_indicia_publisher (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO gcd_series VALUES (1, 1, 'Series', 0);
      INSERT INTO gcd_publisher VALUES (1, 'Publisher');
      INSERT INTO gcd_issue (id, series_id, number, sort_code, variant_of_id) VALUES
        (1, 1, '1', 0, NULL), (2, 1, '-1', 20, NULL), (3, 1, '0', 10, NULL),
        (4, 1, '10', 1, NULL), (5, 1, '2', 2, NULL), (6, 1, '1.5', 3, NULL),
        (9, 1, '1', -1, 1), (8, 1, '1', -1, 1);`)
    assert.deepEqual(browseGcdRecords(database, { seriesId: 1 }).records.map(({ id }) => id), [2, 3, 8, 9, 1, 6, 5, 4])
    assert.deepEqual(browseGcdRecords(database, { seriesId: 1, search: '1' }).records.map(({ id }) => id), [2, 8, 9, 1, 6, 4])

    database.exec('DELETE FROM gcd_issue')
    const insert = database.prepare('INSERT INTO gcd_issue (id, series_id, number, sort_code) VALUES (?, 1, ?, ?)')
    for (let number = 100; number >= -1; number--) insert.run(number + 2, String(number), 100 - number)
    const firstPage = browseGcdRecords(database, { seriesId: 1 })
    const secondPage = browseGcdRecords(database, { seriesId: 1, page: 2 })
    assert.equal(firstPage.hasMore, true)
    assert.equal(firstPage.records.length, 100)
    assert.equal(secondPage.hasMore, false)
    assert.deepEqual([...firstPage.records, ...secondPage.records].map(({ number }) => number), Array.from({ length: 102 }, (_, index) => String(index - 1)))
  } finally { database.close() }
})

test('native sync updates only approved fields and rolls back stale previews', { skip: !process.versions.electron }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const database = new Database(':memory:')
  try {
    database.exec("CREATE TABLE comic_info (id INTEGER PRIMARY KEY, series TEXT, writer TEXT, lastTimeMetadataSet INTEGER, read INTEGER); INSERT INTO comic_info VALUES (1, 'Manual', NULL, 0, 1)")
    const missing = { comicInfoId: 1, libraryField: 'writer', previousValue: null, value: 'Writer' }
    const differing = { comicInfoId: 1, libraryField: 'series', previousValue: 'Manual', value: 'GCD' }
    assert.equal(applyGcdSyncChanges(database, [missing], mappings), 1)
    assert.equal(database.prepare('SELECT series FROM comic_info').get().series, 'Manual')
    assert.equal(applyGcdSyncChanges(database, [differing], mappings), 1)
    assert.equal(database.prepare('SELECT read FROM comic_info').get().read, 1)
    assert.ok(database.prepare('SELECT lastTimeMetadataSet FROM comic_info').get().lastTimeMetadataSet > 0)
    assert.throws(() => applyGcdSyncChanges(database, [
      { ...missing, previousValue: 'Writer', value: 'New writer' },
      { ...differing, previousValue: 'Changed outside app' },
    ], mappings), /changed since the preview/)
    assert.equal(database.prepare('SELECT writer FROM comic_info').get().writer, 'Writer')
    assert.throws(() => applyGcdSyncChanges(database, [{ ...missing, libraryField: 'read' }], mappings), /Unsupported/)
  } finally { database.close() }
})

test('Electron IPC sync scans fixture databases, backs up writes, and rejects stale plans', { skip: !process.versions.electron || process.env.YAC_GCD_SYNC_INTEGRATION !== '1', timeout: 30000 }, async () => {
  const { default: Database } = await import('better-sqlite3')
  const directory = mkdtempSync(path.join(tmpdir(), 'yac-gcd-sync-'))
  const libraryPath = path.join(directory, 'library.ydb')
  const gcdPath = path.join(directory, 'gcd.db')
  const resultPath = path.join(directory, 'result.json')
  const library = new Database(libraryPath)
  library.exec(`CREATE TABLE comic (id INTEGER PRIMARY KEY, comicInfoId INTEGER, fileName TEXT, path TEXT);
    CREATE TABLE comic_info (id INTEGER PRIMARY KEY, series TEXT, title TEXT, number TEXT, volume TEXT, writer TEXT, publisher TEXT, read INTEGER, lastTimeMetadataSet INTEGER);
    INSERT INTO comic_info VALUES (1, 'Linked manual', 'Manual title', '99', NULL, NULL, NULL, 1, 0),
      (2, 'Unique', NULL, '1', NULL, NULL, NULL, 0, 0),
      (3, 'Ambiguous', NULL, '1', NULL, NULL, NULL, 0, 0),
      (4, 'Deleted link', NULL, '1', NULL, NULL, NULL, 0, 0),
      (5, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0);
    INSERT INTO comic VALUES (1, 1, 'Linked.cbz', '/Linked.cbz'), (2, 2, 'Unique #1.cbz', '/Unique #1.cbz'),
      (3, 3, 'Ambiguous #1.cbz', '/Ambiguous #1.cbz'), (4, 4, 'Deleted link #1.cbz', '/Deleted link #1.cbz'),
      (5, 5, 'Inferred #001.cbz', '/Inferred #001.cbz'), (6, 1, 'Duplicate linked.cbz', '/Duplicate linked.cbz');`)
  library.close()
  const gcd = new Database(gcdPath)
  gcd.exec(`CREATE TABLE gcd_issue (id INTEGER PRIMARY KEY, number TEXT, volume TEXT, variant_of_id INTEGER, variant_name TEXT, title TEXT, publication_date TEXT, key_date TEXT, price TEXT, page_count INTEGER, editing TEXT, indicia_frequency TEXT, notes TEXT, isbn TEXT, barcode TEXT, rating TEXT, on_sale_date TEXT, series_id INTEGER, indicia_publisher_id INTEGER, deleted INTEGER DEFAULT 0);
    CREATE TABLE gcd_series (id INTEGER PRIMARY KEY, name TEXT, format TEXT, publisher_id INTEGER, deleted INTEGER DEFAULT 0);
    CREATE TABLE gcd_publisher (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE gcd_indicia_publisher (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE gcd_issue_brand_emblem (issue_id INTEGER, brand_id INTEGER);
    CREATE TABLE gcd_brand (id INTEGER PRIMARY KEY, name TEXT, deleted INTEGER);
    CREATE TABLE gcd_story_type (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE gcd_story (id INTEGER PRIMARY KEY, type_id INTEGER, sequence_number INTEGER, title TEXT, feature TEXT, page_count INTEGER, script TEXT, pencils TEXT, inks TEXT, colors TEXT, letters TEXT, editing TEXT, genre TEXT, characters TEXT, synopsis TEXT, notes TEXT, first_line TEXT, issue_id INTEGER, deleted INTEGER DEFAULT 0);
    INSERT INTO gcd_series (id, name) VALUES (1, 'Linked GCD'), (2, 'Unique'), (3, 'Ambiguous'), (4, 'Ambiguous'), (5, 'Deleted link'), (6, 'Inferred');
    INSERT INTO gcd_issue (id, number, series_id, deleted) VALUES (42, '1', 1, 0), (43, '1', 2, 0), (44, '1', 3, 0), (45, '1', 4, 0), (46, '1', 5, 1), (47, '1', 5, 0), (48, '1', 6, 0);
    INSERT INTO gcd_story_type VALUES (1, 'comic story');
    INSERT INTO gcd_story (id, type_id, sequence_number, script, issue_id) VALUES (1, 1, 1, 'Writer 42', 42), (2, 1, 1, 'Writer 43', 43), (3, 1, 1, 'Writer 48', 48);`)
  gcd.close()
  const enrichment = new Database(path.join(directory, 'enrichment.db'))
  enrichment.exec('CREATE TABLE enrichment (comic_info_id INTEGER PRIMARY KEY, fields_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
  const save = enrichment.prepare('INSERT INTO enrichment (comic_info_id, fields_json) VALUES (?, ?)')
  save.run(1, JSON.stringify({ gcdIssueId: '42', series: 'Saved proposal' }))
  save.run(4, JSON.stringify({ gcdIssueId: '46' }))
  enrichment.close()
  const launcherPath = path.join(directory, 'launch.mjs')
  writeFileSync(launcherPath, `
    import { createRequire } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const require = createRequire(${JSON.stringify(import.meta.url)});
    const { app, BrowserWindow } = require('electron');
    const Database = require('better-sqlite3');
    app.setPath('userData', ${JSON.stringify(directory)});
    await import(${JSON.stringify(new URL('./main.mjs', import.meta.url).href)});
    await app.whenReady();
    const window = BrowserWindow.getAllWindows()[0];
    window.hide();
    const invoke = (code) => window.webContents.executeJavaScript(code);
    try {
      await window.webContents.loadURL('data:text/html,<html>Fixture ready</html>');
      const plan = await invoke('window.libraryApi.previewGcdSync()');
      const database = new Database(${JSON.stringify(libraryPath)});
      const before = database.prepare('SELECT * FROM comic_info WHERE id = 1').get();
      const filled = await invoke('window.libraryApi.applyGcdSync(' + JSON.stringify({ planId: plan.planId, replaceExisting: false }) + ')');
      const afterFill = database.prepare('SELECT * FROM comic_info WHERE id = 1').get();
      const replacePlan = await invoke('window.libraryApi.previewGcdSync()');
      const replaced = await invoke('window.libraryApi.applyGcdSync(' + JSON.stringify({ planId: replacePlan.planId, replaceExisting: true }) + ')');
      const afterReplace = database.prepare('SELECT * FROM comic_info WHERE id = 1').get();
      database.prepare('UPDATE comic_info SET writer = ? WHERE id = 1').run('Manual writer');
      const stalePlan = await invoke('window.libraryApi.previewGcdSync()');
      database.prepare('UPDATE comic_info SET writer = ? WHERE id = 1').run('External writer');
      let staleError = '';
      try { await invoke('window.libraryApi.applyGcdSync(' + JSON.stringify({ planId: stalePlan.planId, replaceExisting: true }) + ')'); } catch (error) { staleError = error.message; }
      const afterStale = database.prepare('SELECT * FROM comic_info WHERE id = 1').get();
      const proposals = new Database(${JSON.stringify(path.join(directory, 'enrichment.db'))});
      const savedProposal = JSON.parse(proposals.prepare('SELECT fields_json FROM enrichment WHERE comic_info_id = 1').get().fields_json);
      proposals.close(); database.close();
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ plan, before, filled, afterFill, replaced, afterReplace, staleError, afterStale, savedProposal }));
    } catch (error) { writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: error.stack })); process.exitCode = 1; }
    app.quit();
  `)
  try {
    const environment = { ...process.env, YAC_GCD_LIBRARY_PATH: libraryPath, YAC_GCD_DATABASE_PATH: gcdPath, VITE_DEV_SERVER_URL: 'data:text/html,<html>Fixture</html>' }
    delete environment.ELECTRON_RUN_AS_NODE
    await promisify(execFile)(process.execPath, [launcherPath], { env: environment, timeout: 25000 })
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    assert.equal(result.error, undefined)
    assert.equal(result.plan.scanned, 5)
    assert.equal(result.plan.matched, 3)
    assert.equal(result.plan.unmatched, 2)
    assert.equal(result.plan.failed, 0)
    assert.equal(result.before.writer, null)
    assert.equal(result.afterFill.writer, 'Writer 42')
    assert.equal(result.afterFill.series, 'Linked manual')
    assert.equal(result.afterFill.number, '99')
    assert.equal(result.afterFill.read, 1)
    assert.equal(result.afterReplace.series, 'Linked GCD')
    assert.equal(result.afterReplace.number, '1')
    assert.ok(existsSync(result.filled.backupPath))
    const backup = new Database(result.filled.backupPath, { readonly: true })
    assert.equal(backup.prepare('SELECT writer FROM comic_info WHERE id = 1').get().writer, null)
    backup.close()
    assert.match(result.staleError, /changed since the preview/)
    assert.equal(result.afterStale.writer, 'External writer')
    assert.equal(result.savedProposal.series, 'Saved proposal')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})