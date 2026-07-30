// Builders that turn a tide/current station + its live state into a Signal K
// `notes` resource. Freeboard-SK renders notes natively: the icon comes from
// `properties.skIcon` (resolved against our `symbols` provider), the marker
// label is the note `name` (shown once the map zoom passes the user's
// "labels" threshold -- that is what makes values appear as you zoom in,
// Garmin-style), and tapping the marker opens the note info panel which
// renders the HTML `description`.
//
// The HTML must survive Angular's sanitizer (Freeboard binds it via
// [innerHTML]): tags/attrs are limited to the sanitizer's allow-list --
// tables with align/width attrs, b/i/small, img with a same-origin src.
// No <style>, no style= attributes, no SVG inline (the graph is an <img>
// pointing at our server-rendered SVG endpoint instead).
'use strict'

const M_TO_FT = 3.28084

/** namespace for skIcon references, matching the symbols provider */
const SYMBOL_NS = 'tidestations'

function fmtHeight(meters, units) {
  return units === 'ft'
    ? `${(meters * M_TO_FT).toFixed(1)} ft`
    : `${meters.toFixed(2)} m`
}

/** Short local time (station timezone when known, else server-local). */
function fmtTime(date, tz) {
  try {
    const opts = { hour: 'numeric', minute: '2-digit' }
    if (tz) opts.timeZone = tz
    return new Intl.DateTimeFormat('en-US', opts).format(date)
  } catch {
    return date.toISOString().slice(11, 16) + 'Z'
  }
}

function truncate(name, n = 18) {
  return name.length > n ? name.slice(0, n - 1) + '…' : name
}

/** note id for a tide station ("noaa/8658901" -> "tide-noaa-8658901") */
function tideNoteId(stationId) {
  return 'tide-' + stationId.replace(/\//g, '-')
}
function currentNoteId(stationId) {
  return 'cur-' + stationId
}

// Gauge granularity: fill icons run tide-<state>-00 .. -20, i.e. 5% of the
// low->high range per step (see tools/generate-symbols.js for why 21).
const TIDE_LEVELS = 20

/**
 * Tide badge icon for a station state.
 * - state known + norm known  -> gauge badge at the nearest 5% fill step
 * - state known + norm null   -> arrow-only badge (never a fake fill level)
 * - state unknown             -> neutral grey badge
 */
function tideIcon(state, norm) {
  if (state !== 'rising' && state !== 'falling') return 'tide-station'
  if (norm == null || !Number.isFinite(norm)) return `tide-${state}`
  const i = Math.round(Math.min(1, Math.max(0, norm)) * TIDE_LEVELS)
  return `tide-${state}-${String(i).padStart(2, '0')}`
}

// Current strength tier breakpoints in knots -> symbol id letter.
// OpenCPN draws current arrows continuously scaled ("the bigger the arrow,
// the more current" -- OpenCPN manual, Tides & Currents); static symbols
// force quantization, and the tiers/breakpoints are justified in
// tools/generate-symbols.js next to the matching arrow geometry.
function strengthTier(speedKn) {
  return speedKn < 1.0 ? 'w' : speedKn < 2.0 ? 'm' : 's'
}

/** Pre-rotated, strength-tiered current arrow icon id. */
function currentIcon(dirDeg, speedKn) {
  const i = Math.round((((dirDeg % 360) + 360) % 360) / 22.5) % 16
  return `current-${strengthTier(speedKn)}-${String(i).padStart(2, '0')}`
}

/**
 * Build the note for a tide station.
 * @param station stationMeta() shape (id like "noaa/8658901")
 * @param state { height, state: 'rising'|'falling'|null, next: [...] }
 */
function buildTideNote(station, state, { units, assetBase, pluginId }) {
  const icon = tideIcon(state.state, state.norm)
  const arrow =
    state.state === 'rising' ? '▲' : state.state === 'falling' ? '▼' : '·'
  const name = `${fmtHeight(state.height, units).replace(' ', '')}${arrow} ${truncate(station.name)}`

  const [src, sid] = station.id.split('/')
  // Cache-buster keyed to the half hour: the browser may cache the graph
  // briefly, but a note re-fetch after 30 min gets a fresh curve.
  const bucket = Math.floor(Date.now() / (30 * 60 * 1000))
  const rows = state.next
    .map(
      (e) =>
        `<tr><td><b>${e.type}</b></td>` +
        `<td>${fmtTime(e.time, station.timezone)}</td>` +
        `<td align="right">${fmtHeight(e.level, units)}</td></tr>`
    )
    .join('')
  const description =
    `<img src="${assetBase}/graph/tide/${encodeURIComponent(src)}/${encodeURIComponent(sid)}.svg?units=${units}&v=${bucket}" width="100%">` +
    `<table width="100%">` +
    `<tr><td><b>Now</b></td><td>${state.state === 'rising' ? 'Rising ▲' : state.state === 'falling' ? 'Falling ▼' : '—'}</td>` +
    `<td align="right">${fmtHeight(state.height, units)}</td></tr>` +
    rows +
    `</table>` +
    `<p><small>NOAA harmonic predictions (neaps) · heights above chart datum · not for navigation</small></p>`

  return [
    tideNoteId(station.id),
    {
      name,
      position: { latitude: station.latitude, longitude: station.longitude },
      description,
      mimeType: 'text/html',
      url: station.url,
      properties: {
        skIcon: `${SYMBOL_NS}:${icon}`,
        readOnly: true,
        plugin: pluginId,
        station: 'tide',
        stationId: station.id,
        state: state.state,
        // normalised cycle position driving the gauge fill (debug/inspect)
        level: state.norm == null ? null : Number(state.norm.toFixed(3))
      },
      $source: pluginId
    }
  ]
}

/**
 * Build the note for a current station.
 * @param station { id, name, latitude, longitude, depth, bin }
 * @param state { speed, dir, phase, next } from Currents.stateAt()
 */
function buildCurrentNote(station, state, { units, assetBase, pluginId }) {
  const slack = state.phase === 'slack'
  const dirKnown = state.dir != null
  // A running current with an unknown direction must never read as slack:
  // keep the speed in the label and fall back to the non-directional icon.
  const icon =
    slack || !dirKnown ? 'current-slack' : currentIcon(state.dir, state.speed)
  const label = slack
    ? `slack ${truncate(station.name)}`
    : `${state.speed.toFixed(1)}kn ${truncate(station.name)}`

  const bucket = Math.floor(Date.now() / (30 * 60 * 1000))
  const rows = (state.next || [])
    .filter((e) => e.type)
    .slice(0, 5)
    .map((e) => {
      const what =
        e.type === 'slack'
          ? 'Slack'
          : e.type === 'flood'
            ? 'Max Flood'
            : 'Max Ebb'
      const v = e.type === 'slack' ? '' : `${Math.abs(e.v).toFixed(1)} kn`
      return (
        `<tr><td><b>${what}</b></td>` +
        `<td>${fmtTime(e.time, null)}</td>` +
        `<td align="right">${v}</td></tr>`
      )
    })
    .join('')
  const phaseTxt = slack
    ? 'Slack water'
    : `${state.phase === 'flood' ? 'Flooding' : 'Ebbing'} ${state.speed.toFixed(1)} kn` +
      (state.dir != null ? ` → ${Math.round(state.dir)}°T` : '')
  const description =
    `<img src="${assetBase}/graph/current/${encodeURIComponent(station.id)}.svg?v=${bucket}" width="100%">` +
    `<table width="100%">` +
    `<tr><td><b>Now</b></td><td colspan="2">${phaseTxt}</td></tr>` +
    rows +
    `</table>` +
    `<p><small>NOAA current predictions · surface bin (${station.depth ? station.depth + ' ft' : 'n/a'}) · not for navigation</small></p>`

  return [
    currentNoteId(station.id),
    {
      name: label,
      position: { latitude: station.latitude, longitude: station.longitude },
      description,
      mimeType: 'text/html',
      url: `https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=${encodeURIComponent(station.id)}`,
      properties: {
        skIcon: `${SYMBOL_NS}:${icon}`,
        readOnly: true,
        plugin: pluginId,
        station: 'current',
        stationId: station.id,
        state: state.phase
      },
      $source: pluginId
    }
  ]
}

module.exports = {
  buildTideNote,
  buildCurrentNote,
  tideNoteId,
  currentNoteId,
  tideIcon,
  currentIcon,
  strengthTier,
  fmtHeight,
  fmtTime,
  SYMBOL_NS,
  M_TO_FT,
  TIDE_LEVELS
}
