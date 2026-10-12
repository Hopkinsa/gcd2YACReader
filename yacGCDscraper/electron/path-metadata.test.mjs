import assert from 'node:assert/strict'
import test from 'node:test'
import { extractPathMetadata } from './path-metadata.mjs'

const examples = [
  ['/00 DC/DC Events/DC Event - 004 - Crisis On Infinite Earths/Crisis On Infinite Earths - #005 - Green Lantern v2 178.cbz', { series: 'Green Lantern', title: 'Green Lantern', number: '178', volume: '2', alternateSeries: 'Crisis On Infinite Earths', alternateNumber: '5' }],
  ['/00 DC/DC Events/DC Event - 100 - Forever Evil Blight/Forever Evil Blight #04 - Constantine 09.cbz', { series: 'Constantine', title: 'Constantine', number: '9', alternateSeries: 'Forever Evil Blight', alternateNumber: '4' }],
  ['/00 Marvel/Marvel Events/Marvel Event - 007 - Phoenix Saga/Phoenix Saga - #003 The Uncanny X-Men 106.cbz', { series: 'The Uncanny X-Men', title: 'The Uncanny X-Men', number: '106', alternateSeries: 'Phoenix Saga', alternateNumber: '3' }],
  ['/00 Marvel/Marvel Events/Marvel Event - 056 - Magneto War/Magneto War - #03 Uncanny X-Men 366.cbz', { series: 'Uncanny X-Men', title: 'Uncanny X-Men', number: '366', alternateSeries: 'Magneto War', alternateNumber: '3' }],
  ['/00 DC/The Immortal Doctor Fate/The Immortal Doctor Fate - 002.cbz', { series: 'The Immortal Doctor Fate', title: 'The Immortal Doctor Fate', number: '2' }],
  ['/00 Marvel/Doctor Strange/#050 - Strange Tales 158.cbz', { series: 'Strange Tales', title: 'Strange Tales', number: '158', alternateSeries: 'Doctor Strange', alternateNumber: '50' }],
  ['/00 Marvel/Doctor Strange/#120 - Defenders v1 17.cbz', { series: 'Defenders', title: 'Defenders', number: '17', volume: '1', alternateSeries: 'Doctor Strange', alternateNumber: '120' }],
  ['/00 Top Cow/Wanted/Wanted #03 (of 06).cbz', { series: 'Wanted', title: 'Wanted', number: '3', count: '6' }],
  ['/00 Vertigo/Area 10/Area 10 - TPB.cbz', { series: 'Area 10', title: 'Area 10' }],
  ['/00 Vertigo/Books of Magic/Books Of Magic - #006.cbz', { series: 'Books Of Magic', title: 'Books Of Magic', number: '6' }],
  ['/00 Dark Horse/Mike Mignola/Hellboy Universe/B P R D/B.P.R.D. #118 - Hell on Earth - The Reign of the Black Flame 03 (of 05).cbz', { series: 'B.P.R.D.', title: 'B.P.R.D.', number: '118', storyArc: 'Hell on Earth - The Reign of the Black Flame', arcNumber: '3', arcCount: '5' }],
  ['/00 Dark Horse/Mike Mignola/Hellboy Universe/Baltimore/Baltimore #035 - Empty Graves 05 (of 05).cbz', { series: 'Baltimore', title: 'Baltimore', number: '35', storyArc: 'Empty Graves', arcNumber: '5', arcCount: '5' }],
  ['/00 Dark Horse/Mike Mignola/Hellboy Universe/Abe Sapien/Abe Sapien #034 - Dark and Terrible Deep.cbz', { series: 'Abe Sapien', title: 'Abe Sapien', number: '34', storyArc: 'Dark and Terrible Deep' }],
]

for (const [filePath, expected] of examples) {
  test(filePath, () => {
    const fileName = filePath.split('/').at(-1)
    assert.deepEqual(extractPathMetadata({ path: filePath, fileName }), expected)
  })
}