// Tide-station discovery and prediction, computed OFFLINE from harmonic
// constituents via the `neaps` library -- the same engine the signalk-tides
// plugin uses (https://github.com/openwatersio/signalk-tides), so predictions
// here agree with the vessel's environment.tide.* paths.
//
// All levels from neaps are METERS above the station's chart datum (MLLW for
// NOAA stations). Unit conversion is the caller's concern.
'use strict'

// `neaps` must be loaded through its ESM entry: its CJS build (via
// @neaps/tide-database's kdbush interop) throws "default.from is not a
// function" with kdbush 4.x. The plugin awaits init() in start().
let neaps = null

async function init() {
  if (!neaps) {
    neaps = await import('neaps')
  }
}

function findStation(id) {
  if (!neaps) throw new Error('tides not initialised')
  return neaps.findStation(id)
}

function stationsNear(opts) {
  if (!neaps) throw new Error('tides not initialised')
  return neaps.stationsNear(opts)
}

// Extremes are computed for a -1 .. +8 day window so "yesterday's" high is
// available for interpolation and the panel can page a week ahead (matches
// signalk-tides' 7-day forecast window plus a day of slack each side).
const WINDOW_BACK_MS = 24 * 3600 * 1000
const WINDOW_FWD_MS = 8 * 24 * 3600 * 1000

// Predictions are pure functions of the harmonics, so cache entries only
// expire to keep the window centred on "now". 1 hour keeps recomputation
// negligible (<1/hr/station) while the window never drifts stale.
const CACHE_TTL_MS = 3600 * 1000
const extremesCache = new Map() // stationId -> { at, extremes }

/** Predictor for a station id (throws if unknown). */
function predictor(stationId) {
  return findStation(stationId)
}

/**
 * Tide stations near a position, closest first.
 * @param {{latitude:number, longitude:number}} pos
 * @param {number} maxKm radius in kilometres
 * @param {number} max maximum stations
 * @returns StationPredictor[] (each has .distance in km)
 */
function stationsNearPos(pos, maxKm, max) {
  return stationsNear({
    latitude: pos.latitude,
    longitude: pos.longitude,
    maxResults: max
  })
    .map((s) => {
      // Fail closed on the radius check: compute the distance ourselves
      // when neaps does not report one, rather than letting a far station
      // through (and showing "0.0 nm" for it in the panel).
      if (typeof s.distance !== 'number') {
        s.distance = haversineKm(
          pos.latitude,
          pos.longitude,
          s.latitude,
          s.longitude
        )
      }
      return s
    })
    .filter((s) => s.distance <= maxKm)
}

/** Great-circle distance in km (haversine). */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = (x) => (x * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Cached extremes (highs/lows) around now for a station. */
function extremesFor(stationId) {
  const hit = extremesCache.get(stationId)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.extremes
  }
  const p = predictor(stationId)
  const extremes = p.getExtremesPrediction({
    start: new Date(now - WINDOW_BACK_MS),
    end: new Date(now + WINDOW_FWD_MS)
  }).extremes
  extremesCache.set(stationId, { at: now, extremes })
  // Bound the cache over a months-long cruise: Maps iterate in insertion
  // order, so evicting the first key is oldest-inserted.
  while (extremesCache.size > 300) {
    extremesCache.delete(extremesCache.keys().next().value)
  }
  return extremes
}

/**
 * Tide state at `time` for a station.
 *
 * Rising/falling rule: the tide is "rising" when the next extreme is a High,
 * "falling" when it is a Low -- the same rule signalk-tides publishes on
 * environment.tide.state and OpenCPN derives its tide-icon state from
 * (next-event direction on the predicted curve).
 */
function stateAt(stationId, time = new Date()) {
  const extremes = extremesFor(stationId)
  const next = extremes.find((e) => e.time >= time)
  const p = predictor(stationId)
  const height = p.getWaterLevelAtTime({ time }).level
  const upcoming = extremes.filter((e) => e.time >= time)
  return {
    height, // meters above chart datum
    state: next ? (next.high ? 'rising' : 'falling') : null,
    next: upcoming.slice(0, 4).map((e) => ({
      time: e.time,
      level: e.level,
      type: e.high ? 'High' : 'Low'
    }))
  }
}

/**
 * Water-level timeline for one station-local calendar day (plus the
 * surrounding extremes), for graphs and the details table.
 * @param {string} stationId
 * @param {Date} dayStart start of the window (UTC instant)
 * @param {Date} dayEnd end of the window
 */
function timelineFor(stationId, dayStart, dayEnd) {
  const p = predictor(stationId)
  const t = p.getTimelinePrediction({ start: dayStart, end: dayEnd })
  const ex = p.getExtremesPrediction({ start: dayStart, end: dayEnd })
  return {
    station: stationMeta(p),
    timeline: t.timeline.map((pt) => ({ time: pt.time, level: pt.level })),
    extremes: ex.extremes.map((e) => ({
      time: e.time,
      level: e.level,
      type: e.high ? 'High' : 'Low'
    }))
  }
}

/** Plain serialisable station metadata. */
function stationMeta(s) {
  return {
    id: s.id,
    name: s.name,
    region: s.region,
    country: s.country,
    latitude: s.latitude,
    longitude: s.longitude,
    timezone: s.timezone,
    type: s.type,
    distance: s.distance,
    url: s.source && s.source.url
  }
}

module.exports = {
  init,
  predictor,
  stationsNearPos,
  extremesFor,
  stateAt,
  timelineFor,
  stationMeta
}
