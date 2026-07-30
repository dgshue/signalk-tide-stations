// Generates the static SVG map symbols into public/symbols/.
//
// Icon conventions (mined from the mature chartplotters -- see README):
// - Garmin chartplotters: tide station = blue icon while the tide is rising,
//   red while falling. We keep those state colours but render the badge as a
//   light "gauge": white body, coloured outline, and a coloured fill bar
//   whose height tracks the actual water level within the current cycle
//   (near-empty at low water, near-full at high water). A small coloured
//   arrow keeps rising/falling readable even when the fill sits mid-range.
// - OpenCPN: current station = orange marker; zoomed in it becomes an arrow
//   rotated to the predicted set (direction the current flows TOWARD), and
//   per the OpenCPN manual "the bigger the arrow, the more current" --
//   i.e. arrow size encodes speed continuously. Freeboard symbols are
//   static, so we quantize that into three strength tiers (see TIERS).
//
// Rotation/animation: Freeboard-SK only rotates markers it manages itself
// (AIS, AtoNs, route vertices), and symbols are discovered once at startup.
// Anything continuously varying must therefore be pre-rendered as a discrete
// set and selected per notes refresh:
// - current direction: one arrow per 22.5-degree compass sector (16 icons,
//   index = round(dir/22.5) % 16). 22.5 degrees is half a compass point
//   finer than any paper current atlas and indistinguishable from
//   continuous rotation at chart marker size.
// - tide level: 21 fill steps per state (tide-rising-00 .. -20, 5% of the
//   low->high range per step). 5% is far below what the eye resolves at
//   ~24 px, but it means the gauge visibly creeps during a 6 h half-cycle
//   (a step every ~10-20 min mid-cycle) instead of jumping.
// - current speed: 3 strength tiers x 16 sectors (see TIERS below).
//
// Run: node tools/generate-symbols.js  (idempotent; output is committed)
'use strict'

const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, '..', 'public', 'symbols')
fs.mkdirSync(OUT, { recursive: true })

// Garmin-like state colours. Blue/red match the rising/falling convention;
// slack grey is our own (Garmin shows no arrow at slack water).
const BLUE = '#0b69c7'
const RED = '#d0342c'
const GREY = '#5f7482'

// Current strength tiers. No mature tool publishes a discrete knot scale
// (OpenCPN scales arrows continuously with rate; Admiralty tidal stream
// atlases draw heavier arrows for stronger streams without naming numbers),
// so the breakpoints are ours: 1 kn is where current starts to matter to a
// displacement-hull passage plan (a 5-6 kn boat gains/loses ~20% SOG), and
// 2 kn marks the "strong stream" regime NOAA/Coast Pilot narratives call
// out for planning slack-water transits. Finer gradation would be spurious
// anyway: speeds between tabulated events come from cosine interpolation.
// Keys are used in symbol ids: current-w-00 .. current-s-15.
const TIERS = {
  //      < 1.0 kn: thin, pale arrow -- present but ignorable
  w: { color: '#ffb74d', edge: '#7a4a00', shaftW: 1.7, headW: 5.5, edgeW: 1.1 },
  // 1.0-2.0 kn: the previous default arrow -- OpenCPN's orange
  m: { color: '#ff9100', edge: '#4a2c00', shaftW: 2.4, headW: 7.0, edgeW: 1.4 },
  //     >= 2.0 kn: fat, deep-orange arrow -- plan around this one
  s: { color: '#e65100', edge: '#3a2000', shaftW: 3.3, headW: 9.0, edgeW: 1.6 }
}
// Ring colour for slack water (kept from the original set).
const ORANGE = '#ff9100'

/**
 * Light "gauge" tide badge (30x30): white body, coloured outline, coloured
 * fill bar from the bottom, small coloured arrow with a white halo so it
 * reads over both the white body and the fill.
 * @param {string} color state colour (outline/arrow/fill)
 * @param {'up'|'down'|'flat'|'none'} arrow direction glyph
 * @param {number|null} frac fill level 0..1, or null for no gauge
 * @param {string} clipId unique clip-path id (SVGs may be inlined together)
 */
function tideBadge(color, arrow, frac, clipId) {
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
      // colour, keeping the badge light per the user's "option 1" mockup
      `<rect x="${ix}" y="${top.toFixed(2)}" width="${iw}" height="${(h + 0.5).toFixed(2)}" fill="${color}" fill-opacity="0.5"/>` +
      // crisp waterline at the fill top so the level reads at a glance
      // (and low water still shows a hairline instead of nothing)
      `<rect x="${ix}" y="${(top - 0.9).toFixed(2)}" width="${iw}" height="1.8" fill="${color}"/>` +
      '</g>'
  }
  let glyph = ''
  if (arrow === 'flat') {
    // neutral / state unknown: two horizontal grey dashes
    glyph =
      `<rect x="9.5" y="11.4" width="11" height="2.4" rx="1.2" fill="${color}"/>` +
      `<rect x="9.5" y="16.2" width="11" height="2.4" rx="1.2" fill="${color}"/>`
  } else if (arrow === 'up' || arrow === 'down') {
    // compact arrow, upper-centre; flip vertically for "down"
    const g = arrow === 'up' ? '' : ' transform="rotate(180 15 12.5)"'
    const d = 'M15 6 L20.2 12.6 L17 12.6 L17 19 L13 19 L13 12.6 L9.8 12.6 Z'
    glyph =
      `<g${g}>` +
      // white halo first so the arrow separates from the fill bar
      `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="${color}"/>` +
      '</g>'
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="30" height="30">' +
    `<defs><clipPath id="${clipId}"><rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="4"/></clipPath></defs>` +
    // thin white halo behind the outline keeps the badge legible over dark
    // (night-mode) charts without the bulk of the old solid block
    '<rect x="2" y="2" width="26" height="26" rx="6.5" fill="#ffffff" stroke="#ffffff" stroke-width="4"/>' +
    `<rect x="2" y="2" width="26" height="26" rx="6.5" fill="#ffffff" stroke="${color}" stroke-width="2.2"/>` +
    gauge +
    glyph +
    '</svg>'
  )
}

/** Current arrow for a strength tier, rotated to `deg` (0 = flowing north). */
function currentArrow(tier, deg) {
  const t = TIERS[tier]
  const d =
    `M17 2.5 L${17 + t.headW} 13 L${17 + t.shaftW} 13 ` +
    `L${17 + t.shaftW} 31.5 L${17 - t.shaftW} 31.5 ` +
    `L${17 - t.shaftW} 13 L${17 - t.headW} 13 Z`
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="34" height="34">' +
    `<g transform="rotate(${deg} 17 17)">` +
    // halo (drawn first, slightly fatter, white)
    `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>` +
    // body
    `<path d="${d}" fill="${t.color}" stroke="${t.edge}" stroke-width="${t.edgeW}" stroke-linejoin="round"/>` +
    '</g>' +
    '</svg>'
  )
}

/** Slack-water current marker: orange ring, no direction. */
function currentSlack() {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="34" height="34">' +
    '<circle cx="17" cy="17" r="8.5" fill="none" stroke="#ffffff" stroke-width="6"/>' +
    `<circle cx="17" cy="17" r="8.5" fill="none" stroke="${ORANGE}" stroke-width="3.6"/>` +
    `<circle cx="17" cy="17" r="1.8" fill="${ORANGE}"/>` +
    '</svg>'
  )
}

const pad = (i) => String(i).padStart(2, '0')

const files = {
  // arrow-only badges: state known but level unknown (also the panel list
  // icons, which have no gauge column of their own)
  'tide-rising.svg': tideBadge(BLUE, 'up', null, 'tr'),
  'tide-falling.svg': tideBadge(RED, 'down', null, 'tf'),
  // fully neutral: state AND level unknown
  'tide-station.svg': tideBadge(GREY, 'flat', null, 'tn'),
  'current-slack.svg': currentSlack()
}
// 21 gauge levels x 2 states; index NN = fill at NN*5% of the cycle range
for (let i = 0; i <= 20; i++) {
  files[`tide-rising-${pad(i)}.svg`] = tideBadge(BLUE, 'up', i / 20, `tr${i}`)
  files[`tide-falling-${pad(i)}.svg`] = tideBadge(RED, 'down', i / 20, `tf${i}`)
}
// 3 strength tiers x 16 direction sectors
for (const tier of Object.keys(TIERS)) {
  for (let i = 0; i < 16; i++) {
    files[`current-${tier}-${pad(i)}.svg`] = currentArrow(tier, i * 22.5)
  }
}

// Remove stale generated files (e.g. the old single-strength current-NN
// set) so the symbols dir always mirrors exactly this script's output.
for (const f of fs.readdirSync(OUT)) {
  if (/^(tide-|current-).*\.svg$/.test(f) && !(f in files)) {
    fs.unlinkSync(path.join(OUT, f))
    console.log(`removed stale ${f}`)
  }
}
for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), svg + '\n')
}
console.log(`wrote ${Object.keys(files).length} symbols to ${OUT}`)
