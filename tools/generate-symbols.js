// Generates the static SVG map symbols into public/symbols/.
//
// Icon conventions (mined from the mature chartplotters -- see README):
// - Garmin chartplotters: tide station = blue icon with UP arrow while the
//   tide is rising, red icon with DOWN arrow while falling. We reproduce that
//   as a rounded-square badge with a bold arrow over a water line.
// - OpenCPN: current station = orange marker; zoomed in it becomes an arrow
//   rotated to the predicted set (direction the current flows TOWARD).
//   We keep OpenCPN's orange for the current arrows.
//
// Rotation: Freeboard-SK only rotates markers it manages itself (AIS, AtoNs,
// route vertices). A note's icon is static, so current direction is encoded
// by pre-rendering one arrow per 22.5-degree compass sector (16 icons,
// current-00 .. current-15, index = round(dir/22.5) % 16). 22.5 degrees is
// half a compass point finer than any paper current atlas and
// indistinguishable from continuous rotation at chart marker size.
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
// OpenCPN current-station orange (their default current arrow colour family).
const ORANGE = '#ff9100'

/** Rounded-square badge with a fat vertical arrow and a water line. */
function tideBadge(fill, arrow) {
  // 30x30 viewBox. White outline keeps the badge legible over any chart.
  const up = arrow === 'up'
  const flat = arrow === 'flat'
  let glyph
  if (flat) {
    // slack / unknown: horizontal double bar
    glyph = '<rect x="8" y="11" width="14" height="3" rx="1.5" fill="#fff"/>' +
      '<rect x="8" y="17" width="14" height="3" rx="1.5" fill="#fff"/>'
  } else {
    // arrow shaft + head; flip vertically for "down"
    const g = up ? '' : ' transform="rotate(180 15 14)"'
    glyph =
      `<g${g}>` +
      '<path d="M15 5.5 L21.5 13.5 L17.4 13.5 L17.4 19 L12.6 19 L12.6 13.5 L8.5 13.5 Z" fill="#fff"/>' +
      '</g>' +
      // water line under the arrow marks this as a tide (water level) badge
      '<path d="M7 23.5 q2 -2.4 4 0 t4 0 t4 0 t4 0" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="30" height="30">' +
    `<rect x="1.5" y="1.5" width="27" height="27" rx="6" fill="${fill}" stroke="#ffffff" stroke-width="2"/>` +
    glyph +
    '</svg>'
  )
}

/** Current arrow rotated to `deg` (0 = flowing north/up-screen). */
function currentArrow(deg) {
  // Long slender arrow, black outline + white halo for chart contrast.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="34" height="34">' +
    `<g transform="rotate(${deg} 17 17)">` +
    // halo (drawn first, slightly fatter, white)
    '<path d="M17 2.5 L24 13 L19.4 13 L19.4 31.5 L14.6 31.5 L14.6 13 L10 13 Z"' +
    ' fill="none" stroke="#ffffff" stroke-width="4" stroke-linejoin="round"/>' +
    // body
    '<path d="M17 2.5 L24 13 L19.4 13 L19.4 31.5 L14.6 31.5 L14.6 13 L10 13 Z"' +
    ` fill="${ORANGE}" stroke="#4a2c00" stroke-width="1.4" stroke-linejoin="round"/>` +
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

const files = {
  'tide-rising.svg': tideBadge(BLUE, 'up'),
  'tide-falling.svg': tideBadge(RED, 'down'),
  'tide-station.svg': tideBadge(GREY, 'flat'),
  'current-slack.svg': currentSlack()
}
for (let i = 0; i < 16; i++) {
  files[`current-${String(i).padStart(2, '0')}.svg`] = currentArrow(i * 22.5)
}

for (const [name, svg] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), svg + '\n')
}
console.log(`wrote ${Object.keys(files).length} symbols to ${OUT}`)
