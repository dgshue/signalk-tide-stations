// signalk-tide-stations -- Garmin-style tide & current stations for
// Freeboard-SK charts.
//
// What it does, end to end:
//
//   1. `symbols` resource provider  -> custom chart icons (blue up-arrow =
//      rising tide, red down-arrow = falling, 16 pre-rotated orange arrows
//      for current set). Freeboard-SK loads these at startup and uses them
//      wherever a note's properties.skIcon references them.
//   2. `notes` resource provider    -> one note per tide/current station
//      near the queried chart position, recomputed per request so the icon
//      (rising/falling), the label value ("2.9ft^ Southport") and the popup
//      forecast are live. Freeboard fetches notes around the map centre on
//      pan/zoom and shows the note NAME as a marker label once zoom passes
//      the user's "labels" threshold -- that gives the Garmin behaviour of
//      values appearing as you zoom in.
//   3. `plotterExtensions` provider -> a toolbar button + side panel inside
//      Freeboard with the interactive forecast: graph for the device's
//      current date/time, a swipeable/scrubbable time bar, a Details table
//      and star-favourites (persisted via the host's extension state).
//   4. HTTP endpoints under /plotterext/signalk-tide-stations/ -- panel
//      assets, symbol SVGs, JSON station/forecast APIs and server-rendered
//      SVG forecast graphs for the note popups.
//
// Tide predictions are computed OFFLINE from harmonic constituents via
// `neaps` (the engine behind signalk-tides). Current predictions come from
// the NOAA CO-OPS API with a disk cache (they have no offline dataset).
'use strict'

const path = require('path')
const crypto = require('crypto')

const tides = require('./tides')
const { Currents } = require('./currents')
const {
  buildTideNote,
  buildCurrentNote,
  MAP_LABEL_MODES,
  SYMBOL_NS,
  M_TO_FT
} = require('./notes')
const {
  TIDE_STYLES,
  CURRENT_STYLES,
  ICON_SIZES,
  tideStyleOf,
  currentStyleOf,
  iconSizeOf,
  catalogue
} = require('./icon-styles')
const { tideSvg, currentSvg } = require('./graph')

const PLUGIN_ID = 'signalk-tide-stations'
// Same namespaced, non-admin-gated base the reference extension
// (signalk-poi-search) uses: /plugins/* is admin-gated, and the
// signalk-webapp keyword would list us in the webapp launcher.
const ASSET_BASE = `/plotterext/${PLUGIN_ID}`
const PUBLIC_DIR = path.join(__dirname, '..', 'public')

const NM_TO_KM = 1.852

let pkg
try {
  pkg = require('../package.json')
} catch {
  pkg = { version: '0.0.0' }
}

/**
 * "what each option looks like" text for an enum config field. The SK admin
 * UI shows one description per property (not per enum value), so the only
 * place to explain the choices is a single block of prose.
 */
function styleBlurb(defs, lead) {
  return (
    lead +
    ' — ' +
    Object.entries(defs)
      .map(([k, v]) => `${k}: ${v.blurb}`)
      .join(' ')
  )
}

module.exports = function (app) {
  let config = {}
  let currents = null
  let running = false
  let routesMounted = false

  const debug = (msg) => app.debug(msg)

  const plugin = {
    id: PLUGIN_ID,
    name: 'Tide & Current Stations',
    description:
      'Garmin-style tide & current station icons on Freeboard-SK charts with forecast panel and favorites.',

    schema: () => ({
      title: 'Tide & Current Stations',
      type: 'object',
      properties: {
        tideIconStyle: {
          type: 'string',
          title: 'Tide station icon style',
          // The admin UI renders `enum` as a dropdown and (in the rjsf
          // versions the SK server ships) uses `enumNames` for the labels;
          // where it does not, the key names are still self-describing and
          // the per-option blurbs are spelled out in the description.
          enum: Object.keys(TIDE_STYLES),
          enumNames: Object.values(TIDE_STYLES).map((s) => s.title),
          description: styleBlurb(
            TIDE_STYLES,
            'All styles use blue while the tide is rising and red while it is falling.'
          ),
          default: 'gauge'
        },
        currentIconStyle: {
          type: 'string',
          title: 'Current station icon style',
          enum: Object.keys(CURRENT_STYLES),
          enumNames: Object.values(CURRENT_STYLES).map((s) => s.title),
          description: styleBlurb(
            CURRENT_STYLES,
            'Arrows always point the way the current flows (the set).'
          ),
          default: 'scaled'
        },
        iconSize: {
          type: 'string',
          title: 'Marker size',
          enum: Object.keys(ICON_SIZES),
          enumNames: ['Small', 'Normal', 'Large'],
          description:
            'Overall size of the tide/current markers on the chart. ' +
            'Unlike the style settings this one is baked into the symbol ' +
            'catalogue, so it only takes effect after Freeboard is reloaded.',
          default: 'normal'
        },
        mapLabel: {
          type: 'string',
          title: 'Text shown beside the marker',
          enum: ['value-name', 'value', 'name', 'none'],
          enumNames: [
            'Reading and station name — "4.3ft▲ Bald Head"',
            'Reading only — "4.3ft▲"',
            'Station name only — "Bald Head"',
            'Nothing — icon only'
          ],
          description:
            'Controls only what is drawn on the chart. The full reading and ' +
            'station name are always kept for the tap popup and the station ' +
            'panel, so hiding the label here loses nothing.',
          default: 'value-name'
        },
        radiusNm: {
          type: 'number',
          title: 'Station search radius (nautical miles)',
          description:
            'Stations further than this from the chart position are not shown.',
          default: 30
        },
        units: {
          type: 'string',
          title: 'Height units',
          enum: ['ft', 'm'],
          default: 'ft'
        },
        showCurrents: {
          type: 'boolean',
          title: 'Show current stations (NOAA CO-OPS, requires internet)',
          default: true
        },
        maxTideStations: {
          type: 'number',
          title: 'Maximum tide stations shown',
          default: 15
        },
        maxCurrentStations: {
          type: 'number',
          title: 'Maximum current stations shown',
          default: 15
        }
      }
    }),

    async start(options) {
      config = Object.assign(
        {
          radiusNm: 30,
          units: 'ft',
          showCurrents: true,
          maxTideStations: 15,
          maxCurrentStations: 15,
          tideIconStyle: 'gauge',
          currentIconStyle: 'scaled',
          iconSize: 'normal',
          mapLabel: 'value-name'
        },
        options || {}
      )
      // Coerce unknown/missing style names back to the defaults here, once,
      // rather than in every call site.
      config.tideIconStyle = tideStyleOf(config.tideIconStyle)
      config.currentIconStyle = currentStyleOf(config.currentIconStyle)
      config.iconSize = iconSizeOf(config.iconSize)
      if (!MAP_LABEL_MODES.includes(config.mapLabel)) {
        config.mapLabel = 'value-name'
      }
      running = true
      let tidesOk = true
      try {
        await tides.init() // loads neaps through its ESM entry
      } catch (err) {
        tidesOk = false
        app.setPluginError(`tide engine failed to load: ${err.message}`)
        app.error(err.message)
      }
      if (currents) {
        currents.close() // stale instance from a previous start must not write
      }
      currents = new Currents({
        dataDir: app.getDataDirPath(),
        debug,
        error: (m) => app.error(m)
      })
      mountRoutes()
      registerNotesProvider()
      registerSymbolsProvider()
      registerExtensionProvider()
      if (config.showCurrents) {
        // Warm the NOAA catalogue in the background so the first chart
        // query can already resolve nearby current stations.
        currents.ensureMeta()
      }
      if (tidesOk) {
        app.setPluginStatus('Started')
      }
    },

    stop() {
      running = false
      if (currents) {
        currents.close()
      }
      // Resource providers are unregistered by the server on plugin stop;
      // the mounted HTTP routes stay (Express cannot unmount) but answer
      // 503 via the `running` guard.
    }
  }

  // ------------------------------------------------------------------
  // shared station queries
  // ------------------------------------------------------------------

  const radiusKm = () => (Number(config.radiusNm) || 30) * NM_TO_KM

  /** Tide station summaries near pos (uses live neaps predictions). */
  function tideSummaries(pos, maxKm) {
    const out = []
    let near = []
    try {
      near = tides.stationsNearPos(
        pos,
        maxKm,
        Number(config.maxTideStations) || 15
      )
    } catch (err) {
      debug(`tide station lookup failed: ${err.message}`)
      return out
    }
    for (const s of near) {
      try {
        const state = tides.stateAt(s.id)
        out.push({ station: tides.stationMeta(s), state })
      } catch (err) {
        debug(`tide state failed for ${s.id}: ${err.message}`)
      }
    }
    return out
  }

  /**
   * Current station summaries near pos. Waits up to `budgetMs` for missing
   * NOAA predictions so the first render after startup already has arrows;
   * afterwards everything is served from cache.
   */
  async function currentSummaries(pos, maxKm, budgetMs = 4000) {
    if (!config.showCurrents) return []
    const stations = await currents.stationsNearPos(
      pos,
      maxKm,
      Number(config.maxCurrentStations) || 15
    )
    const missing = stations.filter((s) => !currents.pred.has(s.id))
    if (missing.length > 0) {
      let timer
      await Promise.race([
        Promise.allSettled(missing.map((s) => currents.fetchPred(s.id))),
        new Promise((r) => {
          timer = setTimeout(r, budgetMs)
        })
      ])
      clearTimeout(timer)
    }
    const out = []
    for (const s of stations) {
      const state = currents.stateAt(s.id)
      if (state) out.push({ station: s, state })
    }
    return out
  }

  // ------------------------------------------------------------------
  // notes resource provider (the chart markers)
  // ------------------------------------------------------------------

  function noteOpts() {
    return {
      units: config.units,
      assetBase: ASSET_BASE,
      pluginId: PLUGIN_ID,
      tideIconStyle: config.tideIconStyle,
      currentIconStyle: config.currentIconStyle,
      mapLabel: config.mapLabel
    }
  }

  /** Parse the server-parsed query into {pos, km} or null. */
  function queryArea(query) {
    if (!query) return null
    let pos = null
    const p = query.position
    if (Array.isArray(p) && p.length >= 2) {
      const lon = Number(p[0])
      const lat = Number(p[1])
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        pos = { latitude: lat, longitude: lon }
      }
    } else if (p && typeof p === 'object') {
      const lat = Number(p.latitude)
      const lon = Number(p.longitude)
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        pos = { latitude: lat, longitude: lon }
      }
    }
    if (!pos) return null
    const distM = Number(query.distance)
    const km = Number.isFinite(distM) && distM > 0
      ? Math.min(distM / 1000, radiusKm())
      : radiusKm()
    return { pos, km }
  }

  async function listNotes(query) {
    if (!running) return {}
    const area = queryArea(query)
    if (!area) return {} // Freeboard probes without a viewport -> no-op
    const notes = {}
    for (const { station, state } of tideSummaries(area.pos, area.km)) {
      try {
        const [id, note] = buildTideNote(station, state, noteOpts())
        notes[id] = note
      } catch (err) {
        debug(`tide note build failed for ${station.id}: ${err.message}`)
      }
    }
    // The currents half must never take the offline tide markers down with
    // it, and must never make the chart wait: pass a zero budget so this
    // returns whatever predictions are already cached. Stations it has not
    // seen still start fetching here and land in the cache, so they appear on
    // the next refresh -- which Freeboard issues on every map move anyway.
    // Blocking instead cost ~4 s on entering new water, and the markers read
    // as missing for that whole time.
    let curList = []
    try {
      let timer
      curList = await Promise.race([
        currentSummaries(area.pos, area.km, 0),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve([]), 6000)
        })
      ])
      clearTimeout(timer)
    } catch (err) {
      debug(`current summaries failed: ${err.message}`)
    }
    for (const { station, state } of curList) {
      try {
        const [id, note] = buildCurrentNote(station, state, noteOpts())
        notes[id] = note
      } catch (err) {
        debug(`current note build failed for ${station.id}: ${err.message}`)
      }
    }
    app.setPluginStatus(
      `${Object.keys(notes).length} stations in last chart query`
    )
    return notes
  }

  async function getNote(id, property) {
    if (!running) throw new Error('plugin stopped')
    let built = null
    if (id.startsWith('tide-')) {
      // "tide-noaa-8658901" -> "noaa/8658901"
      const stationId = id.slice(5).replace('-', '/')
      const p = tides.predictor(stationId) // throws when unknown
      built = buildTideNote(
        tides.stationMeta(p),
        tides.stateAt(stationId),
        noteOpts()
      )
    } else if (id.startsWith('cur-')) {
      const stationId = id.slice(4)
      await currents.ensureMeta()
      const station = currents.stationById(stationId)
      if (!station) throw new Error(`Unknown current station ${stationId}`)
      if (!currents.pred.has(stationId)) {
        await currents.fetchPred(stationId)
      }
      const state = currents.stateAt(stationId)
      if (!state) throw new Error(`No predictions for ${stationId}`)
      built = buildCurrentNote(station, state, noteOpts())
    } else {
      throw new Error(`Not a ${PLUGIN_ID} note: ${id}`)
    }
    const note = built[1]
    if (property === undefined || property === '') {
      return note
    }
    const value = property
      .split('.')
      .reduce(
        (v, k) => (v !== null && typeof v === 'object' ? v[k] : undefined),
        note
      )
    if (value === undefined) {
      throw new Error(`Resource ${id} has no property ${property}`)
    }
    return { value, $source: PLUGIN_ID }
  }

  function registerNotesProvider() {
    app.registerResourceProvider({
      type: 'notes',
      methods: {
        listResources: (query) => listNotes(query),
        getResource: (id, property) => getNote(id, property),
        setResource: () =>
          Promise.reject(new Error('Tide station notes are read-only')),
        deleteResource: () =>
          Promise.reject(new Error('Tide station notes are read-only'))
      }
    })
  }

  // ------------------------------------------------------------------
  // symbols resource provider (the chart icons)
  // ------------------------------------------------------------------

  /** Deterministic UUID from the symbol id (stable across restarts). */
  function symbolUuid(id) {
    const h = crypto
      .createHash('sha1')
      .update(`${PLUGIN_ID}:${id}`)
      .digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
  }

  /**
   * The FULL catalogue -- every style, not just the configured one.
   *
   * Freeboard discovers symbols once at startup and caches a built icon per
   * id, so advertising only the selected style would make a style change
   * publish ids Freeboard has never registered (markers would silently fall
   * back to the generic note pin until a reload). Publishing everything is
   * what makes switching styles take effect on the next notes refresh.
   * See plugin/icon-styles.js.
   */
  function symbolDefs() {
    const sizeMul = ICON_SIZES[config.iconSize] || 1
    const defs = catalogue().map((d) => ({
      id: d.id,
      name: d.name,
      // pixels within the icon's own viewBox; Freeboard passes these to
      // OpenLayers with anchorXUnits/anchorYUnits = "pixels". Centred for
      // the badge styles, at the tip for the pin.
      anchor: d.anchor,
      scale: Number((d.scale * sizeMul).toFixed(3))
    }))
    const now = new Date().toISOString()
    const out = {}
    for (const d of defs) {
      const uuid = symbolUuid(d.id)
      out[uuid] = {
        uuid,
        alias: [`${SYMBOL_NS}:${d.id}`],
        name: d.name,
        description: 'signalk-tide-stations chart marker',
        mediaType: 'image/svg+xml',
        url: `${ASSET_BASE}/symbols/${d.id}.svg`,
        // Deliberately NOT role "note": roles only govern which pickers
        // offer a symbol (rendering is unaffected), and 20 station-state
        // glyphs would clutter the user's note icon picker.
        roles: ['map-marker'],
        scale: d.scale,
        anchor: d.anchor,
        $source: PLUGIN_ID,
        timestamp: now
      }
    }
    return out
  }

  function registerSymbolsProvider() {
    const symbols = symbolDefs()
    const byAlias = {}
    for (const s of Object.values(symbols)) {
      byAlias[s.alias[0]] = s
      byAlias[s.alias[0].split(':')[1]] = s
    }
    app.registerResourceProvider({
      type: 'symbols',
      methods: {
        listResources: async () => (running ? symbols : {}),
        getResource: async (id) => {
          const s = symbols[id] || byAlias[id]
          if (!s) throw new Error(`Unknown symbol ${id}`)
          return s
        },
        setResource: () =>
          Promise.reject(new Error('Tide station symbols are read-only')),
        deleteResource: () =>
          Promise.reject(new Error('Tide station symbols are read-only'))
      }
    })
  }

  // ------------------------------------------------------------------
  // plotterExtensions provider (toolbar button + forecast panel)
  // ------------------------------------------------------------------

  function manifest() {
    return {
      name: 'Tide & Current Stations',
      description:
        'Tide/current station forecast panel: graph, swipeable timeline, details table, favorites.',
      version: pkg.version,
      apiVersion: '1',
      requires: ['panels.iframe'],
      optional: ['buttons', 'map', 'resources.filter', 'units'],
      buttons: [
        {
          id: 'toggle-tide-panel',
          title: 'Tides & Currents',
          slot: 'mapToolbar',
          icon: 'waves',
          action: { type: 'togglePanel', panel: 'tide-stations-panel' }
        }
      ],
      panels: [
        {
          id: 'tide-stations-panel',
          title: 'Tides & Currents',
          type: 'iframe',
          url: `${ASSET_BASE}/panel.html`,
          lifecycle: 'keepAlive'
        }
      ]
    }
  }

  function registerExtensionProvider() {
    app.registerResourceProvider({
      type: 'plotterExtensions',
      methods: {
        listResources: async () =>
          running ? { [PLUGIN_ID]: manifest() } : {},
        getResource: async (id) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(`No such plotterExtensions resource: ${id}`)
          }
          return manifest()
        },
        setResource: () => Promise.reject(new Error('read-only')),
        deleteResource: () => Promise.reject(new Error('read-only'))
      }
    })
  }

  // ------------------------------------------------------------------
  // HTTP routes: JSON APIs, SVG graphs, panel + symbol assets
  // ------------------------------------------------------------------

  function guard(handler) {
    return async (req, res) => {
      if (!running) {
        res.status(503).json({ error: 'plugin stopped' })
        return
      }
      try {
        await handler(req, res)
      } catch (err) {
        debug(`route ${req.path} failed: ${err.message}`)
        res.status(400).json({ error: err.message })
      }
    }
  }

  /** Parse ?start&end ISO params with a default around now. */
  function windowParams(req, defBackH = 0, defFwdH = 24) {
    const now = Date.now()
    let start = req.query.start ? new Date(req.query.start) : null
    let end = req.query.end ? new Date(req.query.end) : null
    if (!start || isNaN(start)) start = new Date(now - defBackH * 3600 * 1000)
    if (!end || isNaN(end)) end = new Date(start.getTime() + defFwdH * 3600 * 1000)
    // clamp to 8 days so a bad client cannot ask for months of timeline
    if (end - start > 8 * 24 * 3600 * 1000) {
      end = new Date(start.getTime() + 8 * 24 * 3600 * 1000)
    }
    return { start, end }
  }

  function mountRoutes() {
    if (routesMounted) return
    if (typeof app.use !== 'function' || typeof app.get !== 'function') {
      app.error('Server app is not an Express application; no HTTP routes')
      return
    }

    // -- JSON: plugin config the panel needs
    app.get(
      `${ASSET_BASE}/api/config`,
      guard(async (req, res) => {
        res.json({
          units: config.units,
          radiusNm: config.radiusNm,
          showCurrents: config.showCurrents,
          // the panel mirrors the chart marker selection in its station list
          tideIconStyle: config.tideIconStyle,
          currentIconStyle: config.currentIconStyle
        })
      })
    )

    // -- JSON: merged station list near a position
    app.get(
      `${ASSET_BASE}/api/stations`,
      guard(async (req, res) => {
        const lat = Number(req.query.latitude)
        const lon = Number(req.query.longitude)
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          res.status(400).json({ error: 'latitude/longitude required' })
          return
        }
        const pos = { latitude: lat, longitude: lon }
        const km = radiusKm()
        const list = []
        for (const { station, state } of tideSummaries(pos, km)) {
          list.push({
            kind: 'tide',
            id: station.id,
            name: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            distanceKm: station.distance,
            timezone: station.timezone,
            state: state.state,
            heightM: state.height,
            norm: state.norm,
            next: state.next
          })
        }
        for (const { station, state } of await currentSummaries(pos, km)) {
          list.push({
            kind: 'current',
            id: station.id,
            name: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            distanceKm: station.distance,
            phase: state.phase,
            speedKn: state.speed,
            dir: state.dir
          })
        }
        list.sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0))
        res.json({ position: pos, units: config.units, stations: list })
      })
    )

    // -- JSON: tide forecast for one station over a window
    app.get(
      `${ASSET_BASE}/api/tide/:src/:sid`,
      guard(async (req, res) => {
        const stationId = `${req.params.src}/${req.params.sid}`
        const { start, end } = windowParams(req)
        const data = tides.timelineFor(stationId, start, end)
        const state = tides.stateAt(stationId)
        res.json({
          ...data,
          now: { time: new Date(), heightM: state.height, state: state.state },
          units: config.units
        })
      })
    )

    // -- JSON: current forecast for one station over a window
    app.get(
      `${ASSET_BASE}/api/current/:id`,
      guard(async (req, res) => {
        const stationId = req.params.id
        await currents.ensureMeta()
        const station = currents.stationById(stationId)
        if (!station) {
          res.status(404).json({ error: `unknown station ${stationId}` })
          return
        }
        if (!currents.pred.has(stationId)) {
          await currents.fetchPred(stationId)
        }
        const { start, end } = windowParams(req)
        const state = currents.stateAt(stationId)
        res.json({
          station,
          series: currents.series(stationId, start, end),
          events: currents
            .eventsTable(stationId)
            .filter((e) => e.time >= start && e.time <= end),
          now: state
            ? { time: new Date(), ...state, next: undefined }
            : null,
          units: 'kn'
        })
      })
    )

    // -- SVG: tide curve for the note popup (device-local today window)
    app.get(
      `${ASSET_BASE}/graph/tide/:src/:sid.svg`,
      guard(async (req, res) => {
        const stationId = `${req.params.src}/${req.params.sid}`
        // Window: -6h .. +18h around now -- shows the ongoing cycle plus
        // the rest of the day, which is what Garmin's popup graph shows.
        const now = new Date()
        const start = new Date(now.getTime() - 6 * 3600 * 1000)
        const end = new Date(now.getTime() + 18 * 3600 * 1000)
        const data = tides.timelineFor(stationId, start, end)
        const state = tides.stateAt(stationId)
        const units = req.query.units === 'm' ? 'm' : 'ft'
        res
          .set('Content-Type', 'image/svg+xml')
          .set('Cache-Control', 'public, max-age=300')
          .send(
            tideSvg({
              timeline: data.timeline,
              extremes: data.extremes,
              units,
              tz: data.station.timezone,
              now,
              state: state.state
            })
          )
      })
    )

    // -- SVG: current curve for the note popup
    app.get(
      `${ASSET_BASE}/graph/current/:id.svg`,
      guard(async (req, res) => {
        const stationId = req.params.id
        // Cold cache (fresh install, tap before any chart query): resolve
        // the station and fetch predictions rather than caching "no data".
        await currents.ensureMeta()
        if (currents.stationById(stationId) && !currents.pred.has(stationId)) {
          await currents.fetchPred(stationId)
        }
        const now = new Date()
        const start = new Date(now.getTime() - 6 * 3600 * 1000)
        const end = new Date(now.getTime() + 18 * 3600 * 1000)
        res
          .set('Content-Type', 'image/svg+xml')
          .set('Cache-Control', 'public, max-age=300')
          .send(
            currentSvg({
              series: currents.series(stationId, start, end),
              tz: null,
              now
            })
          )
      })
    )

    // -- static assets: bus client library + panel + symbols
    // serve-static is a direct dependency: the plugin may be installed as a
    // symlink (npm install <dir>), where require() resolves from the real
    // path and the server's hoisted express is NOT reachable.
    let serveStatic = null
    try {
      serveStatic = require('serve-static')
    } catch {
      try {
        serveStatic = require('express').static
      } catch {
        app.error('serve-static/express not resolvable; assets unavailable')
      }
    }
    if (serveStatic) {
      try {
        // NB: the package's "exports" map does not expose package.json, so
        // resolve via the extension entry (lands in dist/) instead.
        const busDist = path.dirname(
          require.resolve('signalk-plotterext-bus/extension')
        )
        app.use(`${ASSET_BASE}/bus`, serveStatic(busDist))
      } catch (err) {
        app.error(`plotterext bus assets unavailable: ${err.message}`)
      }
      app.use(ASSET_BASE, serveStatic(PUBLIC_DIR))
    }
    routesMounted = true
  }

  return plugin
}
