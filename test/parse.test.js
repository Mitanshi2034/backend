import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrice, parseStock, ParseError } from '../src/scraper/parse.js'

// ---------------------------------------------------------------------------
// The store's OWN formatting functions, copied from its JS bundle
// (functions Fr / Ir / zr in /assets/index-*.js). Testing against these means
// our parser is checked against exactly what the store can render.
// ---------------------------------------------------------------------------
const Fr = (e, t) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: t, maximumFractionDigits: 0 }).format(e)

function Ir(e, t, n) {
  const r = Fr(e, t)
  switch (n) {
    case 'spaced': return r.replace(/,/g, ' ')
    case 'euro': return `${r.replace(/,/g, '.')},00`
    case 'trailing': return `${r}/- (incl. of all taxes)`
    case 'unicode': return r.replace(/[0-9]/g, (d) => String.fromCharCode(65296 + Number(d)))
    case 'nbsp': return r.split('').join('\xA0​')
    case 'lakh': return `Rs.\xA0${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(e)}`
    default: return r
  }
}
const FORMATS = ['default', 'spaced', 'euro', 'trailing', 'unicode', 'nbsp', 'lakh']

// "split" price carrier: each character in its own <span>, joined by a zero-width space.
const splitCarrier = (text) => text.split('').join('​')

const STOCK_TEMPLATES = [
  (e) => `${e} units available`,
  (e) => `Last few: ${e}`,
  (e) => `Available (${e})`,
  (e) => `Stock: ${e} remaining`,
  (e) => `Ready to ship · ${e} available`,
]

test('parses every store price format for many values (incl. split carrier)', () => {
  const values = [7, 99, 999, 1000, 9998, 22950, 56598, 145800, 1115506, 9999999]
  for (let i = 0; i < 300; i++) values.push(1 + Math.floor(Math.random() * 5_000_000))
  for (const value of values) {
    for (const format of FORMATS) {
      const shown = Ir(value, 'INR', format)
      for (const text of [shown, splitCarrier(shown)]) {
        const parsed = parsePrice(text)
        assert.equal(parsed.value, value, `format=${format} text=${JSON.stringify(text)}`)
        assert.equal(parsed.currency, 'INR')
      }
    }
  }
})

test('real examples seen on the live store', () => {
  assert.equal(parsePrice('₹22,950').value, 22950)
  assert.equal(parsePrice('₹1,45,800').value, 145800)
  assert.equal(parsePrice('₹1,15,506').value, 115506)
})

test('refuses anything that is not exactly one price', () => {
  const bad = [
    '',                          // empty
    '   ',                       // blank
    'Price locked',              // no number
    '₹30,197 ₹22,950',           // two prices concatenated (MRP + price)
    'Member price ₹26,574',      // distractor label
    '24% saving',                // badge
    '₹1,45',                     // invalid grouping
    '₹14,5800',                  // invalid grouping
    '₹1.45,800',                 // mixed separators
    '₹1,45,800,00',              // comma used for both thousands and decimals
    'abc123',                    // junk
  ]
  for (const text of bad) {
    assert.throws(() => parsePrice(text), ParseError, `should reject ${JSON.stringify(text)}`)
  }
})

test('parses every store stock template, and "Sold out" as 0', () => {
  for (const n of [1, 3, 36, 143, 194, 999]) {
    for (const template of STOCK_TEMPLATES) {
      assert.deepEqual(parseStock(template(n)), { value: n, recognised: true })
    }
  }
  assert.deepEqual(parseStock('Sold out'), { value: 0, recognised: true })
  assert.deepEqual(parseStock('  Last few:​ 36 '), { value: 36, recognised: true })
})

test('unknown but unambiguous stock wording is accepted and flagged', () => {
  assert.deepEqual(parseStock('Only 4 left in stock'), { value: 4, recognised: false })
})

test('refuses ambiguous or empty stock text', () => {
  for (const text of ['', 'In stock', 'Delivered in 3 business days', '12 of 40 available', 'Hurry!']) {
    assert.throws(() => parseStock(text), ParseError, `should reject ${JSON.stringify(text)}`)
  }
})
