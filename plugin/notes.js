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

const {
  TIDE_LEVELS,
  tideIconId,
  currentIconId,
  strengthTier
} = require('./icon-styles')

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

/** Station names reach the popup as HTML, and they come from NOAA. */
function esc(s) {
  return String(s).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]
  )
}

/** valid `mapLabel` config values, in the order the config UI lists them */
const MAP_LABEL_MODES = ['value-name', 'value', 'name', 'none']

/**
 * Text drawn on the chart next to the icon — the note `name`.
 *
 * Freeboard draws a note's `name` and nothing else, so the label has to be the
 * name itself; a separate property is only honoured by a patched build. `name`
 * is also the popup heading, which is why every popup description opens with
 * the station name in full: shortening the chart label, or turning it off on a
 * crowded chart, then costs nothing on tap.
 *
 * @param value formatted reading, e.g. "4.3ft▼" or "1.0kn" or "slack"
 * @param stationName full station name (truncated here when it is used)
 * @param mode 'value-name' | 'value' | 'name' | 'none'
 */
function composeLabel(value, stationName, mode) {
  switch (mode) {
    case 'value':
      return value
    case 'name':
      return truncate(stationName)
    case 'none':
      return ''
    default: // 'value-name'
      return `${value} ${truncate(stationName)}`
  }
}

/** note id for a tide station ("noaa/8658901" -> "tide-noaa-8658901") */
function tideNoteId(stationId) {
  return 'tide-' + stationId.replace(/\//g, '-')
}
function currentNoteId(stationId) {
  return 'cur-' + stationId
}

// Icon selection lives in ./icon-styles.js so the plugin, the panel and the
// SVG generator all agree on which ids exist. `tideIcon`/`currentIcon` here
// are just the style-aware wrappers the note builders use.

/**
 * Tide badge icon id for a station state, in the user's configured style.
 * - state known + norm known  -> that style's level step nearest 5%
 * - state known + norm null   -> that style's level-unknown form (grey "no
 *   reading" mark, no level element -- never a fake full/empty gauge)
 * - state unknown             -> that style's neutral grey form
 */
function tideIcon(state, norm, style) {
  return tideIconId(style, state, norm)
}

/** Pre-rotated current arrow icon id in the user's configured style. */
function currentIcon(dirDeg, speedKn, style) {
  return currentIconId(style, dirDeg, speedKn)
}

/**
 * Build the note for a tide station.
 * @param station stationMeta() shape (id like "noaa/8658901")
 * @param state { height, state: 'rising'|'falling'|null, next: [...] }
 */
function buildTideNote(
  station,
  state,
  { units, assetBase, pluginId, tideIconStyle, mapLabel: mapLabelMode, labelStyle }
) {
  const icon = tideIcon(state.state, state.norm, tideIconStyle)
  const arrow =
    state.state === 'rising' ? '▲' : state.state === 'falling' ? '▼' : '·'
  const value = `${fmtHeight(state.height, units).replace(' ', '')}${arrow}`
  const name = composeLabel(value, station.name, mapLabelMode)

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
  // NUMBERS BEFORE THE CURVE. Freeboard's note popup is a fixed-height box
  // with no scroll, and a width:100% graph eats most of it -- put the graph
  // first and the extremes table falls below the fold, which is the half a
  // skipper actually needs. If anything is clipped it should be the picture.
  const description =
    // Only name the station here when the chart label does not already: the
    // popup's title bar IS the note name, so repeating it costs a line.
    (mapLabelMode === 'value' || mapLabelMode === 'none'
      ? `<b>${esc(station.name)}</b>`
      : '') +
    `<table width="100%">` +
    `<tr><td><b>Now</b></td><td>${state.state === 'rising' ? 'Rising ▲' : state.state === 'falling' ? 'Falling ▼' : '—'}</td>` +
    `<td align="right">${fmtHeight(state.height, units)}</td></tr>` +
    rows +
    `</table>` +
    `<img src="${assetBase}/graph/tide/${encodeURIComponent(src)}/${encodeURIComponent(sid)}.svg?units=${units}&v=${bucket}" width="100%">` +
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
        // How the host should draw this note's label. Freeboard renders note
        // labels itself and defaults to ~10px, so a marker carrying a live
        // reading has to ask for something legible.
        labelStyle,
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
function buildCurrentNote(
  station,
  state,
  { units, assetBase, pluginId, currentIconStyle, mapLabel: mapLabelMode, labelStyle }
) {
  const slack = state.phase === 'slack'
  const dirKnown = state.dir != null
  // A running current with an unknown direction must never read as slack:
  // keep the speed in the label and fall back to the non-directional icon.
  const icon =
    slack || !dirKnown
      ? 'current-slack'
      : currentIcon(state.dir, state.speed, currentIconStyle)
  const value = slack ? 'slack' : `${state.speed.toFixed(1)}kn`
  const label = composeLabel(value, station.name, mapLabelMode)

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
    (mapLabelMode === 'value' || mapLabelMode === 'none'
      ? `<b>${esc(station.name)}</b>`
      : '') +
    `<table width="100%">` +
    `<tr><td><b>Now</b></td><td colspan="2">${phaseTxt}</td></tr>` +
    rows +
    `</table>` +
    `<img src="${assetBase}/graph/current/${encodeURIComponent(station.id)}.svg?v=${bucket}" width="100%">` +
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
        labelStyle,
        station: 'current',
        stationId: station.id,
        state: state.phase
      },
      $source: pluginId
    }
  ]
}

module.exports = {
  MAP_LABEL_MODES,
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
