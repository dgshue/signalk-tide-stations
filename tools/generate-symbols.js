// Draws the static SVG map symbols into public/symbols/.
//
// The catalogue (which ids exist, their viewBox and anchor) lives in
// plugin/icon-styles.js and is shared with the plugin, so this script cannot
// drift from what the symbols provider advertises: it draws exactly
// catalogue() and fails if the two ever disagree.
//
// Icon conventions (mined from the mature chartplotters -- see README):
// - Garmin chartplotters: tide station = blue icon while the tide is rising,
//   red while falling. Every tide style here keeps those state colours; what
//   the styles differ in is how (and whether) they show the water level
//   within the current cycle.
// - OpenCPN: current station = orange marker; zoomed in it becomes an arrow
//   rotated to the predicted set (direction the current flows TOWARD), and
//   per the OpenCPN manual "the bigger the arrow, the more current" --
//   i.e. arrow size encodes speed continuously. Freeboard symbols are
//   static, so the `scaled` style quantizes that into three strength tiers
//   and the `uniform` style drops it entirely (see TIERS in icon-styles.js).
//
// Rotation/animation: Freeboard-SK only rotates markers it manages itself
// (AIS, AtoNs, route vertices), and symbols are discovered once at startup.
// Anything continuously varying must therefore be pre-rendered as a discrete
// set and selected per notes refresh:
// - current direction: one arrow per 22.5-degree compass sector (16 icons,
//   index = round(dir/22.5) % 16). 22.5 degrees is half a compass point
//   finer than any paper current atlas and indistinguishable from
//   continuous rotation at chart marker size.
// - tide level: 21 steps per state (-00 .. -20), 5% of the low->high range
//   each. See TIDE_LEVELS in icon-styles.js for why 21.
//
// Legibility rules every style follows, so they are interchangeable:
// - a white body plus a fat white halo stroke under the outline. That halo
//   is what keeps the marker readable over dark/night-mode charts and over
//   busy chart detail, and it is why the level fills are drawn at 50%
//   opacity (a pastel tint of the state colour) rather than solid.
// - every coloured glyph that can land on top of a fill gets its own white
//   halo, so it never disappears into the water colour.
// - the LEVEL-UNKNOWN variants (`tide-<style>-rising` / `-falling`) drop the
//   level element entirely and add a grey "no reading" dash. They must not
//   be confusable with a genuine level of 0, so every level-bearing style
//   draws a visible coloured element even at step 00 (a waterline at the
//   bottom, the arc origin tick, the needle pointing straight down).
//
// Run: node tools/generate-symbols.js  (idempotent; output is committed)
'use strict'

const fs = require('fs')
const path = require('path')

const {
  BLUE,
  RED,
  GREY,
  TICK,
  TRACK,
  ORANGE,
  TIDE_LEVELS,
  TIDE_STYLES,
  TIERS,
  CURRENT_SIZE,
  pad,
  dialDegrees,
  catalogue
} = require('../plugin/icon-styles')

const OUT = path.join(__dirname, '..', 'public', 'symbols')
fs.mkdirSync(OUT, { recursive: true })

const n = (v) => Number(v).toFixed(2)

// ---------------------------------------------------------------------
// shared glyph helpers
// ---------------------------------------------------------------------

/** Block arrow pointing up: centred on cx, spanning y0 .. y0+h. */
function arrowPath(cx, y0, h, hw, sw) {
  const yb = y0 + h * 0.55
  const y1 = y0 + h
  return (
    `M${n(cx)} ${n(y0)} L${n(cx + hw)} ${n(yb)} L${n(cx + sw)} ${n(yb)} ` +
    `L${n(cx + sw)} ${n(y1)} L${n(cx - sw)} ${n(y1)} L${n(cx - sw)} ${n(yb)} ` +
    `L${n(cx - hw)} ${n(yb)} Z`
  )
}

/**
 * Arrow glyph with a white halo, flipped for 'down'. The halo is drawn first
 * and slightly fatter so the arrow separates from whatever fill sits behind.
 */
function arrowGlyph(dir, color, cx, y0, h, hw, sw, haloW = 2.6) {
  const d = arrowPath(cx, y0, h, hw, sw)
  const rot =
    dir === 'down' ? ` transform="rotate(180 ${n(cx)} ${n(y0 + h / 2)})"` : ''
  return (
    `<g${rot}>` +
    `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${haloW}" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="${color}"/>` +
    '</g>'
  )
}

/** Stacked rounded dashes -- the "neutral / no reading" motif. */
function dashes(cx, ys, w, color, h = 2.2, opacity = 1) {
  const o = opacity === 1 ? '' : ` fill-opacity="${opacity}"`
  return ys
    .map(
      (y) =>
        `<rect x="${n(cx - w / 2)}" y="${n(y)}" width="${n(w)}" ` +
        `height="${n(h)}" rx="${n(h / 2)}" fill="${color}"${o}/>`
    )
    .join('')
}

/**
 * The single grey dash that marks "state is known but the level is not".
 * Deliberately grey, and deliberately not placed where a level element would
 * be a valid reading, so it cannot be misread as a value.
 */
function noReading(cx, y, w) {
  return dashes(cx, [y], w, TICK, 1.8, 0.75)
}

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
  `width="${w}" height="${h}">${body}</svg>`

// ---------------------------------------------------------------------
// style: gauge -- light badge, coloured outline, fill bar tracking the level
// ---------------------------------------------------------------------

/**
 * @param {string} color state colour (outline / arrow / fill)
 * @param {'up'|'down'|'flat'} arrow direction glyph
 * @param {number|null} frac level 0..1, or null for no level element
 * @param {boolean} unknown true -> state known but level is not
 * @param {string} clipId unique clip-path id (SVGs may be inlined together)
 */
function tideGauge(color, arrow, frac, unknown, clipId) {
  // Interior gauge region, inset from the 2.2px outline.
  const ix = 4.4
  const iy = 4.4
  const iw = 21.2
  const ih = 21.2
  let gauge = ''
  if (frac != null) {
    const h = ih * Math.max(0, Math.min(1, frac))
    const top = iy + ih - h
    gauge =
      `<g clip-path="url(#${clipId})">` +
      // translucent fill over the white body -> pastel tint of the state
      // colour, keeping the badge light enough to read chart detail through
      `<rect x="${ix}" y="${n(top)}" width="${iw}" height="${n(h + 0.5)}" fill="${color}" fill-opacity="0.5"/>` +
      // crisp waterline at the fill top so the level reads at a glance --
      // and so step 00 still shows a coloured hairline instead of nothing
      `<rect x="${ix}" y="${n(top - 0.9)}" width="${iw}" height="1.8" fill="${color}"/>` +
      '</g>'
  }
  let glyph
  if (arrow === 'flat') {
    glyph = dashes(15, [11.4, 16.2], 11, color, 2.4)
  } else {
    glyph = arrowGlyph(arrow, color, 15, 6, 13, 5.2, 2)
    if (unknown) glyph += noReading(15, 21.4, 11)
  }
  return svg(
    30,
    30,
    `<defs><clipPath id="${clipId}"><rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="4"/></clipPath></defs>` +
      // thin white halo behind the outline keeps the badge legible over dark
      // (night-mode) charts without the bulk of a solid block
      '<rect x="2" y="2" width="26" height="26" rx="6.5" fill="#ffffff" stroke="#ffffff" stroke-width="4"/>' +
      `<rect x="2" y="2" width="26" height="26" rx="6.5" fill="#ffffff" stroke="${color}" stroke-width="2.2"/>` +
      gauge +
      glyph
  )
}

// ---------------------------------------------------------------------
// style: staff -- slim vertical tide staff, narrowest footprint of the set
// ---------------------------------------------------------------------

// A tide staff (the graduated board bolted to a wharf pile) is the oldest
// tide display there is and it is unambiguous: you read the waterline
// against the graduations. Drawn narrow on purpose -- its ink is ~9 px wide
// in a 30 px box, so a cluster of stations stays readable where square
// badges would overlap.
function tideStaff(color, arrow, frac, unknown, clipId) {
  const X = 10.6
  const W = 8.8
  const Y = 8.4
  const H = 19.4
  const ix = X + 1.6
  const iw = W - 3.2
  const iy = Y + 1.6
  const ih = H - 3.2

  let water = ''
  let ticks = ''
  if (frac != null) {
    const h = ih * Math.max(0, Math.min(1, frac))
    const top = iy + ih - h
    water =
      `<g clip-path="url(#${clipId})">` +
      `<rect x="${n(ix)}" y="${n(top)}" width="${n(iw)}" height="${n(h + 0.5)}" fill="${color}" fill-opacity="0.5"/>` +
      `<rect x="${n(ix)}" y="${n(top - 0.8)}" width="${n(iw)}" height="1.6" fill="${color}"/>` +
      '</g>'
    // Graduations at quarter / half / three-quarter range, drawn OVER the
    // water so the waterline can be read against them from either side.
    for (const f of [0.25, 0.5, 0.75]) {
      const y = iy + ih * (1 - f)
      const tw = f === 0.5 ? 4.2 : 2.8
      ticks +=
        `<rect x="${n(ix)}" y="${n(y - 0.5)}" width="${n(tw)}" height="1" ` +
        `fill="${TICK}" fill-opacity="0.75"/>`
    }
  }

  let cap
  let mark = ''
  if (arrow === 'flat') {
    // neutral: a flat grey cap plus the two-dash motif inside the column
    cap =
      '<rect x="11.2" y="3.4" width="7.6" height="2.6" rx="1.3" fill="#ffffff" stroke="#ffffff" stroke-width="2.4"/>' +
      `<rect x="11.2" y="3.4" width="7.6" height="2.6" rx="1.3" fill="${color}"/>`
    mark = dashes(15, [15.4, 19.8], 4.6, color, 1.8)
  } else {
    cap = arrowGlyph(arrow, color, 15, 1.2, 6.6, 4.7, 1.8, 2.4)
    if (unknown) mark = dashes(15, [15.4, 19.8], 4.6, TICK, 1.6, 0.75)
  }

  return svg(
    30,
    30,
    `<defs><clipPath id="${clipId}"><rect x="${n(ix)}" y="${n(iy)}" width="${n(iw)}" height="${n(ih)}" rx="1.2"/></clipPath></defs>` +
      `<rect x="${n(X)}" y="${n(Y)}" width="${n(W)}" height="${n(H)}" rx="2.4" fill="#ffffff" stroke="#ffffff" stroke-width="3.6"/>` +
      `<rect x="${n(X)}" y="${n(Y)}" width="${n(W)}" height="${n(H)}" rx="2.4" fill="#ffffff" stroke="${color}" stroke-width="1.9"/>` +
      water +
      ticks +
      mark +
      cap
  )
}

// ---------------------------------------------------------------------
// style: ring -- circular badge, arc sweeping with the level
// ---------------------------------------------------------------------

// A circle covers ~78% of the area of a square with the same bounding box,
// so at identical pixel size this reads as the smallest of the level-bearing
// styles while still carrying a full 0-100% scale on its rim.
function tideRing(color, arrow, frac, unknown) {
  const cx = 15
  const cy = 15
  const R = 12.0 // white body radius
  const RR = 9.2 // progress ring radius
  const SW = 3.2 // ring stroke width
  const C = 2 * Math.PI * RR

  let ring = ''
  if (frac != null) {
    const f = Math.max(0, Math.min(1, frac))
    ring =
      // unfilled track: shows the scale the arc is measured against
      `<circle cx="${cx}" cy="${cy}" r="${RR}" fill="none" stroke="${TRACK}" stroke-width="${SW}"/>` +
      // origin tick at 12 o'clock, always drawn -- so step 00 (a zero-length
      // arc) still shows a coloured element and cannot read as "no data"
      `<rect x="${n(cx - 0.9)}" y="${n(cy - RR - SW / 2)}" width="1.8" height="${n(SW)}" fill="${color}"/>` +
      // the arc: a dash of f*circumference, rotated so 0 sits at the top
      `<circle cx="${cx}" cy="${cy}" r="${RR}" fill="none" stroke="${color}" stroke-width="${n(SW + 0.2)}" ` +
      `stroke-dasharray="${n(f * C)} ${n(C)}" stroke-linecap="butt" transform="rotate(-90 ${cx} ${cy})"/>`
  }

  let glyph
  if (arrow === 'flat') {
    glyph = dashes(cx, [11.6, 16.4], 10, color, 2.2)
  } else {
    glyph = arrowGlyph(arrow, color, cx, 10.4, 8.8, 3.7, 1.6, 2.4)
    if (unknown) glyph += noReading(cx, 20.6, 7.5)
  }

  return svg(
    30,
    30,
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#ffffff" stroke="#ffffff" stroke-width="4"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>` +
      ring +
      glyph
  )
}

// ---------------------------------------------------------------------
// style: pin -- teardrop that fills to the level and points at the station
// ---------------------------------------------------------------------

// The only style anchored at a point rather than its centre: the tip sits
// exactly on the station position, which matters where stations crowd
// together or sit right on a channel edge.
const PIN_PATH =
  'M15 32.6 C 9.2 24.2 5 18.6 5 13 A 10 10 0 1 1 25 13 C 25 18.6 20.8 24.2 15 32.6 Z'
// Waterline travel: step 00 sits at y=26 (where the pin is still ~8 px wide,
// so the waterline is clearly visible) and step 20 at y=3.2, just under the
// crown. Below y=26 the taper is too narrow to read a level in, so it simply
// fills with the rest of the water.
const PIN_Y0 = 26.0
const PIN_Y1 = 3.2

function tidePin(color, arrow, frac, unknown, clipId) {
  let water = ''
  if (frac != null) {
    const f = Math.max(0, Math.min(1, frac))
    const y = PIN_Y0 - (PIN_Y0 - PIN_Y1) * f
    water =
      `<g clip-path="url(#${clipId})">` +
      `<rect x="0" y="${n(y)}" width="30" height="${n(34 - y)}" fill="${color}" fill-opacity="0.5"/>` +
      `<rect x="0" y="${n(y - 0.9)}" width="30" height="1.8" fill="${color}"/>` +
      '</g>'
  }
  let glyph
  if (arrow === 'flat') {
    glyph = dashes(15, [9.6, 14.4], 10, color, 2.2)
  } else {
    // arrow centred in the head (15, 13)
    glyph = arrowGlyph(arrow, color, 15, 8.4, 9.2, 4.0, 1.7)
    if (unknown) glyph += noReading(15, 20.4, 8)
  }
  return svg(
    30,
    34,
    `<defs><clipPath id="${clipId}"><path d="${PIN_PATH}"/></clipPath></defs>` +
      `<path d="${PIN_PATH}" fill="#ffffff" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>` +
      `<path d="${PIN_PATH}" fill="#ffffff" stroke="${color}" stroke-width="1.9" stroke-linejoin="round"/>` +
      water +
      glyph
  )
}

// ---------------------------------------------------------------------
// style: dial -- needle sweeping once per tide cycle
// ---------------------------------------------------------------------

// Unlike the fill styles the dial encodes level AND phase in one quantity:
// the needle makes a single clockwise revolution per cycle (down = low
// water, up = high water; rising climbs the left side, falling descends the
// right). "Where in the cycle are we" is then readable without reading the
// colour, at the cost of a moment's learning.
function tideDial(color, arrow, deg, unknown) {
  const cx = 15
  const cy = 15
  let ticks = ''
  for (let i = 0; i < 12; i++) {
    const major = i === 0 || i === 6 // high water (up) and low water (down)
    const r1 = major ? 11.4 : 11.0
    const r2 = major ? 8.0 : 9.2
    ticks +=
      `<line x1="${cx}" y1="${n(cy - r1)}" x2="${cx}" y2="${n(cy - r2)}" ` +
      `stroke="${major ? GREY : TICK}" stroke-width="${major ? 2 : 1.2}" ` +
      `stroke-linecap="round" transform="rotate(${i * 30} ${cx} ${cy})"/>`
  }
  let face
  if (deg != null) {
    // kite-shaped needle: long point, short tail, so the reading direction
    // is unambiguous at 24 px
    const d = 'M15 3.9 L17.9 14.4 L15 17.6 L12.1 14.4 Z'
    face =
      `<g transform="rotate(${n(deg)} ${cx} ${cy})">` +
      `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="${color}"/>` +
      '</g>' +
      `<circle cx="${cx}" cy="${cy}" r="2.1" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>`
  } else if (arrow === 'flat') {
    face = dashes(cx, [11.6, 16.4], 9, color, 2.2)
  } else {
    // No needle at all IS the "no reading" signal here -- a dial without a
    // needle cannot be misread as a value the way an empty bar could. The
    // state arrow still says which way the tide is going.
    face = arrowGlyph(arrow, color, cx, 10.2, 9.0, 3.6, 1.5, 2.4)
    if (unknown) face += noReading(cx, 21.0, 6.5)
  }
  return svg(
    30,
    30,
    `<circle cx="${cx}" cy="${cy}" r="12.4" fill="#ffffff" stroke="#ffffff" stroke-width="4"/>` +
      `<circle cx="${cx}" cy="${cy}" r="12.4" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>` +
      ticks +
      face
  )
}

// ---------------------------------------------------------------------
// style: arrow -- solid state badge, no level indication
// ---------------------------------------------------------------------

function tideArrowBadge(color, arrow) {
  const glyph =
    arrow === 'flat'
      ? dashes(15, [11.4, 16.2], 11, '#ffffff', 2.4)
      : `<g${arrow === 'down' ? ' transform="rotate(180 15 12.5)"' : ''}>` +
        `<path d="${arrowPath(15, 6, 13, 5.2, 2)}" fill="#ffffff"/></g>`
  return svg(
    30,
    30,
    '<rect x="2" y="2" width="26" height="26" rx="6.5" fill="#ffffff" stroke="#ffffff" stroke-width="4"/>' +
      `<rect x="2" y="2" width="26" height="26" rx="6.5" fill="${color}"/>` +
      glyph
  )
}

// ---------------------------------------------------------------------
// current arrows
// ---------------------------------------------------------------------

/** Current arrow for a strength tier, rotated to `deg` (0 = flowing north). */
function currentArrow(tier, deg) {
  const t = TIERS[tier]
  const d =
    `M17 2.5 L${17 + t.headW} 13 L${17 + t.shaftW} 13 ` +
    `L${17 + t.shaftW} 31.5 L${17 - t.shaftW} 31.5 ` +
    `L${17 - t.shaftW} 13 L${17 - t.headW} 13 Z`
  return svg(
    CURRENT_SIZE.width,
    CURRENT_SIZE.height,
    `<g transform="rotate(${deg} 17 17)">` +
      // halo (drawn first, slightly fatter, white)
      `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>` +
      // body
      `<path d="${d}" fill="${t.color}" stroke="${t.edge}" stroke-width="${t.edgeW}" stroke-linejoin="round"/>` +
      '</g>'
  )
}

/** Slack-water current marker: orange ring, no direction. */
function currentSlack() {
  return svg(
    CURRENT_SIZE.width,
    CURRENT_SIZE.height,
    '<circle cx="17" cy="17" r="8.5" fill="none" stroke="#ffffff" stroke-width="6"/>' +
      `<circle cx="17" cy="17" r="8.5" fill="none" stroke="${ORANGE}" stroke-width="3.6"/>` +
      `<circle cx="17" cy="17" r="1.8" fill="${ORANGE}"/>`
  )
}

// ---------------------------------------------------------------------
// draw everything the catalogue declares
// ---------------------------------------------------------------------

const DRAW = { gauge: tideGauge, staff: tideStaff, ring: tideRing, pin: tidePin }

/**
 * @param {string} style tide style key
 * @param {'rising'|'falling'|null} state
 * @param {number|null} frac level 0..1, null when unknown
 * @param {string} uid unique suffix for clip-path ids
 */
function drawTide(style, state, frac, uid) {
  const color = state === 'rising' ? BLUE : state === 'falling' ? RED : GREY
  const arrow = state === 'rising' ? 'up' : state === 'falling' ? 'down' : 'flat'
  const unknown = state != null && frac == null
  if (style === 'arrow') return tideArrowBadge(color, arrow)
  if (style === 'dial') {
    return tideDial(color, arrow, frac == null ? null : dialDegrees(state, frac), unknown)
  }
  return DRAW[style](color, arrow, frac, unknown, uid)
}

const files = {}

for (const [style, g] of Object.entries(TIDE_STYLES)) {
  for (const state of ['rising', 'falling']) {
    if (g.levels) {
      for (let i = 0; i <= TIDE_LEVELS; i++) {
        files[`tide-${style}-${state}-${pad(i)}.svg`] = drawTide(
          style,
          state,
          i / TIDE_LEVELS,
          `${style}-${state}-${i}`
        )
      }
    }
    files[`tide-${style}-${state}.svg`] = drawTide(
      style,
      state,
      null,
      `${style}-${state}`
    )
  }
  files[`tide-${style}-none.svg`] = drawTide(style, null, null, `${style}-none`)
}

// Legacy ids (pre-styles): same artwork as the gauge fallbacks, kept so any
// stored `tidestations:tide-rising` reference still resolves.
files['tide-rising.svg'] = drawTide('gauge', 'rising', null, 'legacy-r')
files['tide-falling.svg'] = drawTide('gauge', 'falling', null, 'legacy-f')
files['tide-station.svg'] = drawTide('gauge', null, null, 'legacy-n')

// current tiers (3 scaled + 1 uniform) x 16 direction sectors
for (const tier of Object.keys(TIERS)) {
  for (let i = 0; i < 16; i++) {
    files[`current-${tier}-${pad(i)}.svg`] = currentArrow(tier, i * 22.5)
  }
}
files['current-slack.svg'] = currentSlack()

// Cross-check against the catalogue the plugin advertises: a mismatch either
// way means either a note could reference a symbol with no file, or that
// Freeboard would register a symbol whose URL 404s.
const declared = new Set(catalogue().map((d) => d.id + '.svg'))
const drawn = new Set(Object.keys(files))
const missing = [...declared].filter((f) => !drawn.has(f))
const extra = [...drawn].filter((f) => !declared.has(f))
if (missing.length || extra.length) {
  console.error('catalogue/drawing mismatch')
  if (missing.length) console.error(`  declared, not drawn: ${missing.join(', ')}`)
  if (extra.length) console.error(`  drawn, not declared: ${extra.join(', ')}`)
  process.exit(1)
}

// Remove stale generated files (e.g. the pre-styles tide-rising-NN set) so
// the symbols dir always mirrors exactly this script's output.
for (const f of fs.readdirSync(OUT)) {
  if (/^(tide-|current-).*\.svg$/.test(f) && !(f in files)) {
    fs.unlinkSync(path.join(OUT, f))
    console.log(`removed stale ${f}`)
  }
}
for (const [name, s] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), s + '\n')
}
console.log(`wrote ${Object.keys(files).length} symbols to ${OUT}`)
