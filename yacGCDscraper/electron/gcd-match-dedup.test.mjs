import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalGcdCandidates } from './gcd-match-dedup.mjs'

test('collapses GCD cover variants onto the root issue', () => {
  const candidates = canonicalGcdCandidates([
    { id: 1281154, variantOfId: 1279808, score: 100, onSaleDate: '2014-11-12', pageCount: 28, barcode: '84428400379706011' },
    { id: 1284411, variantOfId: 1279808, score: 100, onSaleDate: '2014-11-12', pageCount: 28, barcode: '84428400379706021' },
    { id: 1279808, variantOfId: null, score: 100, onSaleDate: '2014-11-12', pageCount: 28, barcode: '84428400379706011' },
  ])
  assert.deepEqual(candidates.map(({ id }) => id), [1279808])
})

test('keeps distinct high-confidence issues for review', () => {
  const candidates = canonicalGcdCandidates([
    { id: 1279808, variantOfId: null, score: 100, onSaleDate: '2014-11-12', pageCount: 28 },
    { id: 1721895, variantOfId: null, score: 100, publicationDate: '2017' },
  ])
  assert.deepEqual(candidates.map(({ id }) => id), [1279808, 1721895])
})

test('returns one canonical candidate when it alone is fully confident', () => {
  const candidates = canonicalGcdCandidates([
    { id: 1, variantOfId: null, score: 100, onSaleDate: '2014-11-12', pageCount: 28 },
    { id: 2, variantOfId: null, score: 70, publicationDate: '2017' },
  ])
  assert.deepEqual(candidates.map(({ id }) => id), [1])
})