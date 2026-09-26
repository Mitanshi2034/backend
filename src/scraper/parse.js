// Turns the text the store shows into numbers, or refuses.
// These functions never guess: if the text is not clearly ONE price / ONE stock
// number in a format we recognise, they throw, and the scrape attempt fails
// honestly instead of storing something wrong.

export class ParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ParseError'
  }
}

// Zero-width space/joiners, word joiner, BOM, soft hyphen: invisible characters the
// store inserts between letters/digits to break naive text matching.
const INVISIBLE = /[​-‍⁠﻿­]/g

const CURRENCY_PREFIX = /^(₹|Rs\.?|INR|\$|€|£)/i

/**
 * Parse a displayed price into a number.
 * Handles every format the store uses (see docs/STORE_RECON.md):
 *   "₹1,45,800"  "₹1 45 800"  "₹1.45.800,00"  "₹1,45,800/- (incl. of all taxes)"
 *   "₹１,４５,８００" (full-width digits)  "₹ 1 , 4 5 …" (chars split by NBSP+ZWSP)
 *   "Rs. 1,45,800.00"
 * @returns {{ value: number, currency: string | null }}
 */
export function parsePrice(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) throw new ParseError('empty price text')

  // NFKC folds full-width digits (１２３ -> 123) and NBSP into plain characters.
  let s = rawText.normalize('NFKC').replace(INVISIBLE, '')
  // Spaces are only ever thousands separators or padding in this store, so drop them all.
  // (This also undoes the "one character per NBSP" format.)
  s = s.replace(/\s+/g, '')
  // Trailing "/- (incl. of all taxes)" style suffix.
  s = s.replace(/\/-(\(.*\))?$/, '')

  const currencyMatch = s.match(CURRENCY_PREFIX)
  const currency = currencyMatch ? normaliseCurrency(currencyMatch[1]) : null
  if (currencyMatch) s = s.slice(currencyMatch[0].length)

  // Whatever remains must be ONLY digits and separators. A second currency sign or any
  // letter means we are looking at more than one value (or the wrong element).
  if (!/^[\d.,]+$/.test(s)) throw new ParseError(`not a single price: "${rawText}"`)

  // Decimal part: thousands groups always end in 3 digits, so a separator followed by
  // exactly 2 digits at the very end can only be a decimal separator ("…,00" or "….00").
  let fraction = ''
  let decimalSeparator = null
  const decimal = s.match(/([.,])(\d{2})$/)
  // A comma is a decimal separator only in the euro style ("1.45.800,00", "999,00").
  // Otherwise "1,45" would silently become 1.45; instead it falls through and fails the grouping check.
  const commaIsDecimal = decimal?.[1] === ',' && (s.slice(0, -3).includes('.') || decimal[2] === '00')
  if (decimal && (decimal[1] === '.' || commaIsDecimal)) {
    decimalSeparator = decimal[1]
    fraction = decimal[2]
    s = s.slice(0, -decimal[0].length)
  }

  // Integer part: at most one kind of thousands separator, and valid grouping:
  // Indian (1,45,800) or Western (145,800) or none (145800).
  const separators = new Set(s.replace(/\d/g, ''))
  if (separators.size > 1) throw new ParseError(`mixed thousands separators: "${rawText}"`)
  if (decimalSeparator && separators.has(decimalSeparator)) {
    throw new ParseError(`same character used for thousands and decimals: "${rawText}"`)
  }
  if (separators.size === 1) {
    const groups = s.split([...separators][0])
    const [first, ...rest] = groups
    const last = rest.at(-1)
    const middle = rest.slice(0, -1)
    const valid =
      /^\d{1,3}$/.test(first) && /^\d{3}$/.test(last) && middle.every((g) => /^\d{2,3}$/.test(g))
    if (!valid) throw new ParseError(`invalid digit grouping: "${rawText}"`)
  }
  const digits = s.replace(/[.,]/g, '')
  if (!/^\d+$/.test(digits)) throw new ParseError(`no digits in price: "${rawText}"`)

  const value = Number(`${digits}.${fraction || '0'}`)
  if (!Number.isFinite(value)) throw new ParseError(`price is not a number: "${rawText}"`)
  return { value, currency }
}

function normaliseCurrency(symbol) {
  const s = symbol.toUpperCase()
  if (s === '₹' || s.startsWith('RS') || s === 'INR') return 'INR'
  if (s === '$') return 'USD'
  if (s === '€') return 'EUR'
  if (s === '£') return 'GBP'
  return null
}

// The store's five stock templates (plus "Sold out"). Matched strictly first.
const STOCK_TEMPLATES = [
  /^(\d+) units available$/i,
  /^Last few: (\d+)$/i,
  /^Available \((\d+)\)$/i,
  /^Stock: (\d+) remaining$/i,
  /^Ready to ship · (\d+) available$/i,
]
const SOLD_OUT = /^(sold out|out of stock|currently unavailable)$/i

/**
 * Parse the stock pill text into a number.
 * @returns {{ value: number, recognised: boolean }}
 *   recognised=false means the wording was new to us but still unambiguous
 *   (exactly one number + a stock word). Recorded so wording changes are visible.
 */
export function parseStock(rawText) {
  if (typeof rawText !== 'string') throw new ParseError('empty stock text')
  const s = rawText.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (!s) throw new ParseError('empty stock text')

  if (SOLD_OUT.test(s)) return { value: 0, recognised: true }
  for (const template of STOCK_TEMPLATES) {
    const m = s.match(template)
    if (m) return { value: Number(m[1]), recognised: true }
  }

  // Unknown wording: accept only if it is clearly about stock and has exactly one integer.
  const numbers = s.match(/\d+/g) ?? []
  if (numbers.length === 1 && /(available|stock|remaining|left|few|ship)/i.test(s)) {
    return { value: Number(numbers[0]), recognised: false }
  }
  throw new ParseError(`unrecognised stock text: "${rawText}"`)
}
