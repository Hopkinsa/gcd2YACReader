import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Exercise the IPC implementation without starting Electron or opening a user's library.
const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
const implementation = source.slice(source.indexOf('async function bulkUpdateComicMetadata('), source.indexOf('async function extractFolderPathMetadata('))
const columns = ['series', 'title', 'number', 'volume', 'publisher', 'storyArc', 'arcNumber', 'alternateSeries', 'alternateNumber', 'lastTimeMetadataSet']

function createHarness() {
  const writes = []
  const backups = []
  const database = {
    prepare(sql) {
      if (sql === 'PRAGMA table_info(comic_info)') return { all: () => columns.map((name) => ({ name })) }
      assert.match(sql, /^UPDATE comic_info SET /)
      const fields = sql.slice('UPDATE comic_info SET '.length, sql.indexOf(' WHERE')).split(', ').map((assignment) => assignment.split(' = ')[0])
      return {
        run(...values) {
          const id = values.pop()
          writes.push({ id, fields: Object.fromEntries(fields.map((field, index) => [field, values[index]])) })
          return { changes: 1 }
        },
      }
    },
    transaction: (callback) => callback,
    close() {},
  }
  const update = runInNewContext(`${implementation}\nbulkUpdateComicMetadata`, {
    libraryPath: '/test/library.ydb',
    openLibrary: () => ({ backup: async (destination) => { backups.push(destination) }, close() {} }),
    Database: function () { return database },
  })
  return { update, writes, backups }
}

test('bulk auto-increments follow the visible list sort, not loaded or selection order', async () => {
  const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const initializers = new Map()
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['sortedComics', 'selectedComics'].includes(node.name.getText(app))) {
      initializers.set(node.name.getText(app), node.initializer.getText(app))
    }
    ts.forEachChild(node, visit)
  }
  visit(app)
  assert.equal(initializers.size, 2)
  const comics = [
    { id: 1, comicInfoId: 10, number: '10' },
    { id: 2, comicInfoId: 20, number: '2' },
    { id: 3, comicInfoId: 30, number: '1' },
    { id: 4, comicInfoId: 40, number: '3' },
  ]
  for (const [direction, expectedIds] of [['ascending', [30, 20, 10]], ['descending', [10, 20, 30]]]) {
    const selected = runInNewContext(`const sortedComics = ${initializers.get('sortedComics')}; ${initializers.get('selectedComics')}`, {
      data: { comics }, librarySort: { field: 'number', direction }, selectedComicIds: new Set([2, 1, 3]),
    })
    const { update, writes } = createHarness()
    await update(selected.map((comic) => comic.comicInfoId), { arcNumber: '5', alternateNumber: '10' }, ['arcNumber', 'alternateNumber'])
    assert.deepEqual(writes.map(({ id }) => id), expectedIds)
    assert.deepEqual(writes.map(({ fields }) => [fields.arcNumber, fields.alternateNumber]), [['5', '10'], ['6', '11'], ['7', '12']])
  }
})

test('bulk edits save arc and alternative series with independently incremented numbers in selection order', async () => {
  const { update, writes, backups } = createHarness()
  const result = await update([30, 10, 30, 20], {
    storyArc: 'A story arc', arcNumber: '3', alternateSeries: 'An alternative series', alternateNumber: '10',
  }, ['arcNumber', 'alternateNumber'])
  assert.equal(result.updatedComics, 3)
  assert.equal(backups.length, 1)
  assert.equal(result.backupPath, backups[0])
  assert.deepEqual(writes.map(({ id, fields }) => [id, fields.storyArc, fields.arcNumber, fields.alternateSeries, fields.alternateNumber]), [
    [30, 'A story arc', '3', 'An alternative series', '10'],
    [10, 'A story arc', '4', 'An alternative series', '11'],
    [20, 'A story arc', '5', 'An alternative series', '12'],
  ])
  assert.ok(writes.every(({ fields }) => !Object.hasOwn(fields, 'title')))
})

test('bulk numbers repeat when increment is off and can be incremented independently', async () => {
  const { update, writes } = createHarness()
  await update([1, 2], { arcNumber: '5', alternateNumber: '2' }, ['alternateNumber'])
  assert.deepEqual(writes.map(({ fields }) => [fields.arcNumber, fields.alternateNumber]), [['5', '2'], ['5', '3']])
})

test('existing issue and volume increments remain supported', async () => {
  const { update, writes } = createHarness()
  await update([1, 2], { number: '1.5', volume: '2', publisher: 'Publisher' }, ['number', 'volume'])
  assert.deepEqual(writes.map(({ fields }) => [fields.number, fields.volume, fields.publisher]), [
    ['1.5', '2', 'Publisher'], ['2.5', '3', 'Publisher'],
  ])
})

test('invalid new increment values and nonnumeric increment fields fail before creating a backup', async () => {
  const { update, backups, writes } = createHarness()
  await assert.rejects(update([1], { arcNumber: 'invalid' }, ['arcNumber']), /Arc number must start with a number/)
  await assert.rejects(update([1], { alternateNumber: 'invalid' }, ['alternateNumber']), /Alternative number must start with a number/)
  await assert.rejects(update([1], { storyArc: 'An arc' }, ['storyArc']), /Only issue, volume, arc number, and alternative number/)
  assert.equal(backups.length, 0)
  assert.equal(writes.length, 0)
})
