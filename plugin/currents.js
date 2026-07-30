// NOAA CO-OPS current-prediction stations: metadata catalogue + per-station
// flood/ebb/slack event predictions, with disk caching so the chart keeps
// working offline on data already fetched.
//
// Endpoints (no API key; see https://api.tidesandcurrents.noaa.gov/):
// - metadata: /mdapi/prod/webapi/stations.json?type=currentpredictions
// - events:   /api/prod/datagetter?product=currents_predictions&interval=30
//   For subordinate ("S") stations NOAA returns tabulated events only
//   (slack / max flood / max ebb), the same tables OpenCPN's tcmgr consumes.
//
// Speed-now algorithm: cosine interpolation between tabulated events --
// v(t) = v0 + (v1-v0) * (1 - cos(pi * (t-t0)/(t1-t0))) / 2 -- the classic
// xtide/OpenCPN rule for stations that only publish max/slack tables.
// Positive velocity = flood (meanFloodDir), negative = ebb (meanEbbDir).
'use strict'

const fs = require('fs')
const path = require('path')

const MDAPI =
  'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions&units=english'
const DATAGETTER = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'

// Catalogue changes rarely; a week matches crows-nest's refresh horizon for
// the same dataset.
const META_TTL_MS = 7 * 24 * 3600 * 1000
// Predictions are fetched for a [today-1 .. today+7] day window; refetch when
// the window no longer reaches 2 days ahead (so one fetch serves ~5 days).
const PRED_FWD_DAYS = 7
const PRED_MIN_LEAD_MS = 2 * 24 * 3600 * 1000
// Below this speed the station is shown as slack water. OpenCPN draws its
// smallest current arrow around a tenth of a knot; under that an arrow
// direction is noise.
const SLACK_KNOTS = 0.1
// Limit concurrent NOAA fetches (an unthrottled 15-station burst has been
// observed to fail wholesale, presumably rate limiting) and back off
// failures so an offshore/offline boat never hammers a dead link.
const FETCH_CONCURRENCY = 4
const FETCH_FAIL_BACKOFF_MS = 5 * 60 * 1000

class Currents {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir plugin data dir for disk cache
   * @param {(msg:string)=>void} opts.debug
   * @param {(msg:string)=>void} opts.error
   */
  constructor({ dataDir, debug, error }) {
    this.dataDir = dataDir
    this.debug = debug || (() => {})
    this.error = error || (() => {})
    this.meta = null // [{id,name,lat,lng,bin,depth,type}] deduped by id
    this.metaAt = 0
    this.metaInflight = null
    this.metaFailedAt = 0
    this.closed = false // set by close(); a stale instance must not write
    this.saveTimer = null
    this.pred = new Map() // stationId -> { fetchedAt, begin, end, events }
    this.failedAt = new Map() // stationId -> last failure ms
    this.inflight = new Map() // stationId -> Promise
    this.active = 0 // running NOAA fetches (see FETCH_CONCURRENCY)
    this.queue = [] // waiters for a fetch slot
    fs.mkdirSync(dataDir, { recursive: true })
    this.loadDisk()
  }

  // ---------- disk cache ----------

  file(name) {
    return path.join(this.dataDir, name)
  }

  loadDisk() {
    try {
      const m = JSON.parse(fs.readFileSync(this.file('currents-meta.json')))
      this.meta = m.stations
      this.metaAt = m.fetchedAt
    } catch {
      /* no cache yet */
    }
    let p = null
    try {
      p = JSON.parse(fs.readFileSync(this.file('currents-pred.json')))
    } catch {
      /* no cache yet */
    }
    if (p && typeof p === 'object') {
      // Validate per entry so one corrupt record cannot discard the rest.
      for (const [id, v] of Object.entries(p)) {
        try {
          if (!Array.isArray(v.events) || typeof v.end !== 'string') continue
          v.events.forEach((e) => (e.time = new Date(e.time)))
          this.pred.set(id, v)
        } catch {
          /* skip bad entry */
        }
      }
    }
  }

  /** Stop a stale instance (plugin restart): no more writes or new fetches. */
  close() {
    this.closed = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    // release any queued fetch waiters so their promises settle
    while (this.queue.length) this.queue.shift()()
  }

  atomicWrite(name, data) {
    const tmp = this.file(name + '.tmp')
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, this.file(name))
  }

  saveMeta() {
    if (this.closed) return
    this.atomicWrite(
      'currents-meta.json',
      JSON.stringify({ fetchedAt: this.metaAt, stations: this.meta })
    )
  }

  /** Debounced, pruned, atomic persist of the prediction cache. */
  savePred() {
    if (this.closed || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.closed) return
      // prune: drop windows that no longer cover yesterday, cap total size
      const cutoff = dateStamp(new Date(Date.now() - 24 * 3600 * 1000))
      for (const [id, v] of this.pred.entries()) {
        if (!v.end || v.end < cutoff) this.pred.delete(id)
      }
      while (this.pred.size > 200) {
        this.pred.delete(this.pred.keys().next().value) // oldest insertion
      }
      const out = {}
      for (const [id, v] of this.pred.entries()) out[id] = v
      try {
        this.atomicWrite('currents-pred.json', JSON.stringify(out))
      } catch (err) {
        this.debug(`pred cache write failed: ${err.message}`)
      }
    }, 5000)
    // Allow the plugin to stop cleanly without a pending timer holding node
    if (this.saveTimer.unref) this.saveTimer.unref()
  }

  // ---------- station catalogue ----------

  /** Ensure the station catalogue is loaded (fetches when stale).
   * In-flight-deduped and failure-backed-off: chart queries arrive on every
   * pan/zoom, and an offline boat must not stack 30s catalogue fetches
   * (a stale-but-present cache keeps being served meanwhile). */
  async ensureMeta() {
    if (this.meta && Date.now() - this.metaAt < META_TTL_MS) {
      return this.meta
    }
    if (Date.now() - this.metaFailedAt < FETCH_FAIL_BACKOFF_MS) {
      return this.meta // stale or null; retry later
    }
    if (this.metaInflight) {
      return this.metaInflight
    }
    this.metaInflight = this.fetchMeta().finally(() => {
      this.metaInflight = null
    })
    return this.metaInflight
  }

  async fetchMeta() {
    try {
      this.debug('fetching NOAA current station catalogue')
      const res = await fetch(MDAPI, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`mdapi HTTP ${res.status}`)
      const body = await res.json()
      // The catalogue repeats a station once per depth bin; keep the
      // shallowest bin (nearest the surface -- what a chartplotter shows).
      // Type "W" (weak & variable) stations carry no usable direction.
      const byId = new Map()
      for (const s of body.stations || []) {
        if (s.type === 'W') continue
        const depth = Number(s.depth) || 0
        const prev = byId.get(s.id)
        if (!prev || depth < prev.depth) {
          byId.set(s.id, {
            id: s.id,
            name: s.name,
            latitude: s.lat,
            longitude: s.lng,
            bin: s.currbin,
            depth,
            type: s.type
          })
        }
      }
      this.meta = [...byId.values()]
      this.metaAt = Date.now()
      this.saveMeta()
      this.debug(`current catalogue: ${this.meta.length} stations`)
    } catch (err) {
      // Keep whatever cache we have; currents just stay unavailable offline.
      this.metaFailedAt = Date.now()
      this.error(`NOAA current catalogue fetch failed: ${err.message}`)
    }
    return this.meta
  }

  /** Current stations within maxKm of pos, closest first. */
  async stationsNearPos(pos, maxKm, max) {
    const meta = await this.ensureMeta()
    if (!meta) return []
    const out = []
    for (const s of meta) {
      const d = haversineKm(pos.latitude, pos.longitude, s.latitude, s.longitude)
      if (d <= maxKm) out.push({ ...s, distance: d })
    }
    out.sort((a, b) => a.distance - b.distance)
    return out.slice(0, max)
  }

  stationById(id) {
    return (this.meta || []).find((s) => s.id === id)
  }

  // ---------- predictions ----------

  /**
   * Prediction events for a station, from cache; kicks off a background
   * fetch when missing/stale. Returns null when nothing cached yet.
   */
  events(stationId) {
    const hit = this.pred.get(stationId)
    // hit.end is a NOAA YYYYMMDD stamp; parse it explicitly (Date() cannot).
    // A malformed/missing stamp reads as stale, never as a throw.
    const endMs =
      hit && typeof hit.end === 'string' && hit.end.length === 8
        ? Date.UTC(
            Number(hit.end.slice(0, 4)),
            Number(hit.end.slice(4, 6)) - 1,
            Number(hit.end.slice(6, 8))
          )
        : 0
    const fresh = hit && endMs - Date.now() > PRED_MIN_LEAD_MS
    if (!fresh) {
      this.fetchPred(stationId) // fire & forget; dedupes/backoffs internally
    }
    return hit ? hit.events : null
  }

  /**
   * Tabulated slack / max-flood / max-ebb events. Subordinate stations get
   * these straight from NOAA; harmonic stations return an interval series,
   * so events are derived from it (zero crossings = slack, |v| local maxima
   * = max flood/ebb -- the classic tide-table reduction).
   */
  eventsTable(stationId) {
    const rows = this.events(stationId)
    if (!rows || rows.length === 0) return []
    if (rows.some((r) => r.type)) {
      return rows.filter((r) => r.type)
    }
    const out = []
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]
      const b = rows[i]
      // slack: velocity sign change between consecutive samples
      if ((a.v <= 0) !== (b.v <= 0) && a.v !== b.v) {
        const f = Math.abs(a.v) / (Math.abs(a.v) + Math.abs(b.v))
        out.push({
          time: new Date(
            a.time.getTime() + f * (b.time.getTime() - a.time.getTime())
          ),
          v: 0,
          type: 'slack',
          floodDir: a.floodDir,
          ebbDir: a.ebbDir
        })
      }
      // max flood/ebb: |v| local maximum above the slack threshold
      const c = rows[i + 1]
      if (
        c &&
        Math.abs(b.v) >= Math.abs(a.v) &&
        Math.abs(b.v) > Math.abs(c.v) &&
        Math.abs(b.v) > SLACK_KNOTS
      ) {
        out.push({
          time: b.time,
          v: b.v,
          type: b.v > 0 ? 'flood' : 'ebb',
          floodDir: b.floodDir,
          ebbDir: b.ebbDir
        })
      }
    }
    return out
  }

  /** Await the prediction fetch (used by API/list paths with a timeout). */
  fetchPred(stationId) {
    if (this.closed) {
      return Promise.resolve(null)
    }
    if (this.inflight.has(stationId)) {
      return this.inflight.get(stationId)
    }
    const failed = this.failedAt.get(stationId)
    if (failed && Date.now() - failed < FETCH_FAIL_BACKOFF_MS) {
      return Promise.resolve(null)
    }
    const station = this.stationById(stationId)
    if (!station) return Promise.resolve(null)
    const begin = dateStamp(new Date(Date.now() - 24 * 3600 * 1000))
    const end = dateStamp(
      new Date(Date.now() + PRED_FWD_DAYS * 24 * 3600 * 1000)
    )
    const url =
      `${DATAGETTER}?station=${encodeURIComponent(stationId)}` +
      `&product=currents_predictions&bin=${station.bin || 1}` +
      `&interval=30&time_zone=gmt&units=english&format=json` +
      `&begin_date=${begin}&end_date=${end}`
    const p = (async () => {
      await this.acquireSlot()
      try {
        this.debug(`fetching current predictions for ${stationId}`)
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
        if (!res.ok) throw new Error(`datagetter HTTP ${res.status}`)
        const body = await res.json()
        const rows = body.current_predictions && body.current_predictions.cp
        if (!Array.isArray(rows) || rows.length === 0) {
          // A clean "no data for this station" is a cacheable answer, not a
          // failure: remember it so the station is not re-fetched (and the
          // chart query does not pay its warm-up budget) every pass.
          const empty = { fetchedAt: Date.now(), begin, end, events: [] }
          this.pred.set(stationId, empty)
          this.savePred()
          return []
        }
        const events = rows.map((r) => ({
          // NOAA returns "YYYY-MM-DD HH:mm" in the requested zone (gmt)
          time: new Date(r.Time.replace(' ', 'T') + 'Z'),
          v: Number(r.Velocity_Major) || 0, // knots, +flood / -ebb
          type: r.Type, // slack | flood | ebb (absent on interval series)
          floodDir: Number(r.meanFloodDir),
          ebbDir: Number(r.meanEbbDir)
        }))
        const entry = { fetchedAt: Date.now(), begin, end, events }
        this.pred.set(stationId, entry)
        this.failedAt.delete(stationId)
        this.savePred()
        return events
      } catch (err) {
        this.failedAt.set(stationId, Date.now())
        this.debug(`current predictions failed for ${stationId}: ${err.message}`)
        return null
      } finally {
        this.inflight.delete(stationId)
        this.releaseSlot()
      }
    })()
    this.inflight.set(stationId, p)
    return p
  }

  acquireSlot() {
    if (this.active < FETCH_CONCURRENCY) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  releaseSlot() {
    const next = this.queue.shift()
    if (next) next()
    else this.active--
  }

  /**
   * Interpolated state at `time`: { speed (kn, >=0), dir (degT), phase }.
   * phase: 'flood' | 'ebb' | 'slack'. Returns null without cached data.
   */
  stateAt(stationId, time = new Date(), withNext = true) {
    const events = this.events(stationId)
    if (!events || events.length === 0) return null
    const t = time.getTime()
    let before = null
    let after = null
    for (const e of events) {
      const et = e.time.getTime()
      if (et <= t) before = e
      else {
        after = e
        break
      }
    }
    if (!before || !after) return null // outside the cached window
    const f = (t - before.time.getTime()) /
      (after.time.getTime() - before.time.getTime())
    // Cosine ramp between tabulated event velocities (see file header).
    const v = before.v + (after.v - before.v) * (1 - Math.cos(Math.PI * f)) / 2
    const speed = Math.abs(v)
    const phase = speed < SLACK_KNOTS ? 'slack' : v > 0 ? 'flood' : 'ebb'
    const dir = v >= 0 ? before.floodDir : before.ebbDir
    return {
      speed,
      dir: Number.isFinite(dir) ? dir : null,
      phase,
      // eventsTable is a full derivation pass; series() skips it per-step
      next: withNext
        ? this.eventsTable(stationId)
            .filter((e) => e.time.getTime() > t)
            .slice(0, 6)
        : []
    }
  }

  /** 10-minute interpolated series over [start, end) for graphs. */
  series(stationId, start, end) {
    const out = []
    for (let t = start.getTime(); t < end.getTime(); t += 10 * 60 * 1000) {
      const s = this.stateAt(stationId, new Date(t), false)
      if (!s) continue
      out.push({
        time: new Date(t),
        // signed for the graph: +flood / -ebb
        v: s.phase === 'ebb' ? -s.speed : s.speed
      })
    }
    return out
  }
}

function dateStamp(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
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

module.exports = { Currents, SLACK_KNOTS, haversineKm }
