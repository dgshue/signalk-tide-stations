// Single source of truth for the chart-symbol catalogue: which icon styles
// exist, how big each one is, where its anchor sits, and how a live station
// state maps onto a symbol id.
//
// Required by BOTH the plugin (plugin/notes.js picks ids, plugin/index.js
// advertises the `symbols` resources) and the generator
// (tools/generate-symbols.js draws the files). Keeping it in one module is
// what guarantees "every id the notes provider can emit is a file that
// exists and a catalogue entry Freeboard has registered".
//
// WHY EVERY STYLE IS PRE-GENERATED
// Freeboard-SK discovers `symbols` exactly once, at startup, and caches the
// built OpenLayers icon per symbol id. If the plugin only published the
// *selected* style, changing the setting would publish ids Freeboard has
// never seen and markers would silently fall back to the generic note pin
// until the user reloaded Freeboard. Publishing the whole catalogue instead
// means switching styles only changes which already-registered id the notes
// carry -- the new icons appear on the next notes refresh (a pan/zoom), with
// no regeneration step and, after the first reload that picks the catalogue
// up, no reload either.
'use strict'

// Garmin-like state colours. Blue/red match the rising/falling convention
// every chartplotter uses for tide stations; slack grey is our own (Garmin
// shows no arrow when it has no state).
const BLUE = '#0b69c7'
const RED = '#d0342c'
const GREY = '#5f7482'
// Muted greys for scale furniture (gauge ticks, dial ticks, ring track) and
// for the explicit "no reading" marks.
const TICK = '#90a4ae'
const TRACK = '#ccd6dd'

// Level granularity: ids run -00 .. -20, i.e. 5% of the low->high range per
// step. 5% is far below what the eye resolves at ~24 px, but it means a
// level-bearing icon visibly creeps during a 6 h half-cycle (a step every
// ~10-20 min mid-cycle) instead of jumping between a few coarse states.
const TIDE_LEVELS = 20

/**
 * Tide icon styles.
 *
 * `levels: true` -> the style has a live level indication and therefore a
 * -00..-20 series per state. `levels: false` -> state only.
 *
 * Sizes are the SVG viewBox; `anchor` is in pixels within that box and is
 * passed straight through to OpenLayers (Freeboard's buildIcon() sets
 * anchorXUnits/anchorYUnits = "pixels"). Centre-anchored styles put the
 * station position at the icon centre; the pin is anchored at its tip so it
 * points at the station instead of hovering over it.
 */
const TIDE_STYLES = {
  gauge: {
    title: 'Gauge badge (default)',
    blurb:
      'Rounded badge with a coloured outline and a fill bar that rises with the water level.',
    width: 30,
    height: 30,
    anchor: [15, 15],
    scale: 0.9,
    levels: true
  },
  staff: {
    title: 'Tide staff',
    blurb:
      'Slim vertical staff with tick marks; water fills from the bottom to the live level. Narrowest footprint.',
    width: 30,
    height: 30,
    anchor: [15, 15],
    scale: 0.95,
    levels: true
  },
  ring: {
    title: 'Ring',
    blurb:
      'Circular badge with an arc that sweeps round in proportion to the level. Reads smaller than a square.',
    width: 30,
    height: 30,
    anchor: [15, 15],
    scale: 0.9,
    levels: true
  },
  pin: {
    title: 'Map pin',
    blurb:
      'Teardrop pin that fills with colour to the live level and points exactly at the station.',
    width: 30,
    height: 34,
    // tip of the teardrop -- the pin points AT the position
    anchor: [15, 33],
    scale: 0.9,
    levels: true
  },
  dial: {
    title: 'Dial',
    blurb:
      'Clock-like face whose needle sweeps low -> high -> low once per tide cycle.',
    width: 30,
    height: 30,
    anchor: [15, 15],
    scale: 0.9,
    levels: true
  },
  arrow: {
    title: 'Plain arrow',
    blurb:
      'Solid coloured badge with just an up/down arrow. No level indication -- least visual noise.',
    width: 30,
    height: 30,
    anchor: [15, 15],
    scale: 0.85,
    levels: false
  }
}

/**
 * Current arrow strength tiers.
 *
 * No mature tool publishes a discrete knot scale (OpenCPN scales arrows
 * continuously with rate -- "the bigger the arrow, the more current",
 * OpenCPN manual, Tides & Currents; Admiralty tidal stream atlases draw
 * heavier arrows for stronger streams without naming numbers), so the
 * breakpoints are ours: 1 kn is where current starts to matter to a
 * displacement-hull passage plan (a 5-6 kn boat gains/loses ~20% SOG), and
 * 2 kn marks the "strong stream" regime NOAA/Coast Pilot narratives call out
 * for planning slack-water transits. Finer gradation would be spurious
 * anyway: speeds between tabulated events come from cosine interpolation.
 *
 * `u` is the uniform-style arrow: geometrically identical to `m` (OpenCPN's
 * orange) so the two styles look like the same family, but selected for
 * every speed so the marker carries direction only.
 */
const TIERS = {
  //      < 1.0 kn: thin, pale arrow -- present but ignorable
  w: { color: '#ffb74d', edge: '#7a4a00', shaftW: 1.7, headW: 5.5, edgeW: 1.1 },
  // 1.0-2.0 kn: the reference arrow -- OpenCPN's orange
  m: { color: '#ff9100', edge: '#4a2c00', shaftW: 2.4, headW: 7.0, edgeW: 1.4 },
  //     >= 2.0 kn: fat, deep-orange arrow -- plan around this one
  s: { color: '#e65100', edge: '#3a2000', shaftW: 3.3, headW: 9.0, edgeW: 1.6 },
  // uniform style: one weight for every speed (speed still in the label)
  u: { color: '#ff9100', edge: '#4a2c00', shaftW: 2.4, headW: 7.0, edgeW: 1.4 }
}
/** Ring colour for slack water (shared by both current styles). */
const ORANGE = '#ff9100'

const CURRENT_STYLES = {
  scaled: {
    title: 'Speed-scaled arrows (default)',
    blurb:
      'Three arrow weights: thin/pale under 1 kn, orange 1-2 kn, fat deep-orange at 2 kn and above.',
    tiers: ['w', 'm', 's']
  },
  uniform: {
    title: 'Uniform arrows',
    blurb:
      'One arrow weight for every speed -- direction only, less visual noise. Speed is still in the marker label.',
    tiers: ['u']
  }
}

/** Geometry shared by every current arrow and the slack ring. */
const CURRENT_SIZE = { width: 34, height: 34, anchor: [17, 17], scale: 0.8 }

/**
 * Overall marker size. Multiplies each style's base `scale`, which Freeboard
 * hands to OpenLayers verbatim. NB: unlike the style setting this one is
 * baked into the symbol catalogue, so it only takes effect after Freeboard
 * is reloaded (see the note at the top of this file).
 */
const ICON_SIZES = { small: 0.75, normal: 1.0, large: 1.3 }

const pad = (i) => String(i).padStart(2, '0')

/** Coerce a configured style name to a known one (defaults on garbage). */
function tideStyleOf(style) {
  return Object.hasOwn(TIDE_STYLES, style || '') ? style : 'gauge'
}
function currentStyleOf(style) {
  return Object.hasOwn(CURRENT_STYLES, style || '') ? style : 'scaled'
}
function iconSizeOf(size) {
  return Object.hasOwn(ICON_SIZES, size || '') ? size : 'normal'
}

/**
 * Symbol id for a tide station state.
 *
 * - state known + level known   -> level series at the nearest 5% step
 * - state known + level UNKNOWN -> `<style>-<state>`: the style silhouette
 *   with every level element removed and an explicit grey "no reading" mark.
 *   Never a fake full/empty gauge -- an empty gauge is a real reading (low
 *   water) and must not be confused with "we could not compute a level".
 * - state unknown               -> `<style>-none`: fully neutral grey.
 */
function tideIconId(style, state, norm) {
  const st = tideStyleOf(style)
  if (state !== 'rising' && state !== 'falling') return `tide-${st}-none`
  if (!TIDE_STYLES[st].levels || norm == null || !Number.isFinite(norm)) {
    return `tide-${st}-${state}`
  }
  const i = Math.round(Math.min(1, Math.max(0, norm)) * TIDE_LEVELS)
  return `tide-${st}-${state}-${pad(i)}`
}

/** Strength tier letter for a speed under the given current style. */
function strengthTier(speedKn, style) {
  if (currentStyleOf(style) === 'uniform') return 'u'
  return speedKn < 1.0 ? 'w' : speedKn < 2.0 ? 'm' : 's'
}

/** Pre-rotated current arrow id (16 sectors of 22.5 deg). */
function currentIconId(style, dirDeg, speedKn) {
  const i = Math.round((((dirDeg % 360) + 360) % 360) / 22.5) % 16
  return `current-${strengthTier(speedKn, style)}-${pad(i)}`
}

/**
 * Dial needle bearing, in degrees clockwise from "up".
 *
 * The needle makes ONE continuous clockwise revolution per full tide cycle:
 * low water points down (180), high water points up (0/360). Rising sweeps
 * 180 -> 360, falling carries on 0 -> 180. At 21 level steps that is 9 deg
 * per step, which is plainly visible at marker size.
 */
function dialDegrees(state, frac) {
  return state === 'rising' ? 180 + 180 * frac : 180 * (1 - frac)
}

/**
 * The complete symbol catalogue: every id the notes provider can ever emit,
 * with the geometry Freeboard needs. Consumed by the symbols provider and by
 * the generator (which draws exactly this list).
 * @returns {{id:string,name:string,width:number,height:number,anchor:number[],scale:number}[]}
 */
function catalogue() {
  const out = []
  const add = (id, name, g, scale) =>
    out.push({
      id,
      name,
      width: g.width,
      height: g.height,
      anchor: g.anchor,
      scale: scale != null ? scale : g.scale
    })

  for (const [key, g] of Object.entries(TIDE_STYLES)) {
    const label = g.title.replace(/ \(default\)$/, '')
    for (const state of ['rising', 'falling']) {
      const cap = state[0].toUpperCase() + state.slice(1)
      if (g.levels) {
        for (let i = 0; i <= TIDE_LEVELS; i++) {
          add(
            `tide-${key}-${state}-${pad(i)}`,
            `Tide ${state}, ${i * 5}% of range (${label})`,
            g
          )
        }
      }
      add(`tide-${key}-${state}`, `Tide ${cap.toLowerCase()} (${label})`, g)
    }
    add(`tide-${key}-none`, `Tide station, state unknown (${label})`, g)
  }

  // Legacy ids from before styles existed. Kept as their own catalogue
  // entries (same artwork as the gauge fallbacks) so anything that stored a
  // bare `tidestations:tide-rising` reference still resolves.
  add('tide-rising', 'Tide rising (legacy alias)', TIDE_STYLES.gauge)
  add('tide-falling', 'Tide falling (legacy alias)', TIDE_STYLES.gauge)
  add('tide-station', 'Tide station (legacy alias)', TIDE_STYLES.gauge)

  const tierName = { w: 'weak', m: 'moderate', s: 'strong', u: 'uniform' }
  for (const t of Object.keys(TIERS)) {
    for (let i = 0; i < 16; i++) {
      add(
        `current-${t}-${pad(i)}`,
        `Current ${tierName[t]} ${i * 22.5} deg`,
        CURRENT_SIZE
      )
    }
  }
  add('current-slack', 'Current slack', CURRENT_SIZE)
  return out
}

module.exports = {
  BLUE,
  RED,
  GREY,
  TICK,
  TRACK,
  ORANGE,
  TIDE_LEVELS,
  TIDE_STYLES,
  CURRENT_STYLES,
  CURRENT_SIZE,
  TIERS,
  ICON_SIZES,
  pad,
  tideStyleOf,
  currentStyleOf,
  iconSizeOf,
  tideIconId,
  currentIconId,
  strengthTier,
  dialDegrees,
  catalogue
}
