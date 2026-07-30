// Tides & Currents forecast panel (Freeboard-SK plotter extension).
//
// Runs inside the host's panel iframe and talks to the host over the plotter
// extension bus (map centring, favorites via host-persisted state, note-layer
// filter). All station/forecast data comes from the plugin's same-origin
// JSON API, so the panel also works with the bus unavailable (favorites then
// fall back to localStorage and the map buttons hide).
import { connectExtension } from './bus/extension.js'

const BASE = '.' // panel.html and the api/ routes share the asset base

const M_TO_FT = 3.28084
const DAY_MS = 24 * 3600 * 1000

const $ = (id) => document.getElementById(id)

let loadForecastToken = 0

const state = {
  client: null, // bus client or null outside a host
  // overwritten from /api/config on init; these are the plugin's defaults
  cfg: {
    units: 'ft',
    showCurrents: true,
    tideIconStyle: 'gauge',
    currentIconStyle: 'scaled'
  },
  pos: null, // {latitude, longitude}
  stations: [],
  favorites: [], // ["tide:noaa/8658901", "current:ACT6446"]
  layerHidden: false,
  sel: null, // selected station summary
  dayOffset: 0, // 0 = today
  forecast: null, // fetched detail data for sel+dayOffset
  scrubIdx: null,
  detailsOpen: false
}

// ---------------------------------------------------------------- utilities

function fmtHeight(m) {
  return state.cfg.units === 'ft'
    ? `${(m * M_TO_FT).toFixed(1)} ft`
    : `${m.toFixed(2)} m`
}
function fmtTime(d) {
  return new Date(d).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
}
function fmtDay(d) {
  return new Date(d).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}
function nmi(km) {
  return (km / 1.852).toFixed(1)
}
/** Escape external text (station names) before innerHTML interpolation. */
function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;'
  })[c])
}
function stationKey(s) {
  return `${s.kind}:${s.id}`
}
function dayBounds(offset) {
  // Calendar-day paging (setDate, not +24h) so DST transitions keep the
  // window aligned with local midnight and the day label truthful.
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() + offset)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}
async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------- favorites

async function loadFavorites() {
  if (state.client) {
    try {
      const r = await state.client.call('state.get', {
        scope: 'extension',
        keys: ['favorites']
      })
      const v = r && r.values && r.values.favorites
      if (Array.isArray(v)) {
        state.favorites = v
        return
      }
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    state.favorites = JSON.parse(
      localStorage.getItem('tide-stations-favorites') || '[]'
    )
  } catch {
    state.favorites = []
  }
}

async function saveFavorites() {
  localStorage.setItem(
    'tide-stations-favorites',
    JSON.stringify(state.favorites)
  )
  if (state.client) {
    try {
      await state.client.call('state.set', {
        scope: 'extension',
        values: { favorites: state.favorites }
      })
    } catch {
      /* localStorage copy is the fallback */
    }
  }
}

function toggleFavorite(key) {
  const i = state.favorites.indexOf(key)
  if (i >= 0) state.favorites.splice(i, 1)
  else state.favorites.push(key)
  saveFavorites()
}

// ---------------------------------------------------------------- position

async function resolvePosition() {
  if (state.client) {
    try {
      const v = await state.client.call('map.getView', {})
      if (v && Array.isArray(v.center)) {
        return { latitude: v.center[1], longitude: v.center[0] }
      }
    } catch {
      /* fall through */
    }
  }
  try {
    const r = await getJSON(
      '/signalk/v1/api/vessels/self/navigation/position/value'
    )
    if (r && Number.isFinite(r.latitude)) return r
  } catch {
    /* no position */
  }
  return null
}

// ---------------------------------------------------------------- list view

async function refreshList() {
  $('status').textContent = 'Loading…'
  state.pos = await resolvePosition()
  if (!state.pos) {
    $('status').textContent = 'No position (no fix and no map view).'
    $('station-list').innerHTML =
      '<div class="empty">Waiting for a position…</div>'
    return
  }
  try {
    const r = await getJSON(
      `${BASE}/api/stations?latitude=${state.pos.latitude}&longitude=${state.pos.longitude}`
    )
    state.cfg.units = r.units || state.cfg.units
    state.stations = r.stations || []
    renderList()
  } catch (err) {
    $('status').textContent = `Load failed: ${err.message}`
  }
}

// Tide styles that carry a level; `arrow` has none. Duplicated from
// plugin/icon-styles.js because the panel runs in the browser and cannot
// require() it -- keep the two in step when adding a style.
const LEVELLESS_TIDE_STYLES = ['arrow']

function iconFor(s) {
  // Mirrors plugin/icon-styles.js tideIconId()/currentIconId() so the list
  // icon is exactly the marker shown on the chart, in the configured style.
  if (s.kind === 'tide') {
    const st = state.cfg.tideIconStyle || 'gauge'
    if (s.state !== 'rising' && s.state !== 'falling') return `tide-${st}-none`
    if (
      LEVELLESS_TIDE_STYLES.includes(st) ||
      s.norm == null ||
      !Number.isFinite(s.norm)
    ) {
      return `tide-${st}-${s.state}`
    }
    const lvl = Math.round(Math.min(1, Math.max(0, s.norm)) * 20)
    return `tide-${st}-${s.state}-${String(lvl).padStart(2, '0')}`
  }
  if (s.phase === 'slack' || s.dir == null) return 'current-slack'
  const tier =
    state.cfg.currentIconStyle === 'uniform'
      ? 'u'
      : s.speedKn < 1.0
        ? 'w'
        : s.speedKn < 2.0
          ? 'm'
          : 's'
  const i = Math.round((((s.dir % 360) + 360) % 360) / 22.5) % 16
  return `current-${tier}-${String(i).padStart(2, '0')}`
}

function valueFor(s) {
  if (s.kind === 'tide') {
    const arrow = s.state === 'rising' ? '▲' : s.state === 'falling' ? '▼' : ''
    return {
      text: `${fmtHeight(s.heightM)} ${arrow}`,
      cls: s.state || ''
    }
  }
  return {
    text: s.phase === 'slack' ? 'slack' : `${s.speedKn.toFixed(1)} kn`,
    cls: 'cur'
  }
}

function renderList() {
  const el = $('station-list')
  el.innerHTML = ''
  const favs = state.stations.filter((s) =>
    state.favorites.includes(stationKey(s))
  )
  const rest = state.stations.filter(
    (s) => !state.favorites.includes(stationKey(s))
  )
  const ordered = [...favs, ...rest]
  if (ordered.length === 0) {
    el.innerHTML = '<div class="empty">No stations within range.</div>'
  }
  for (const s of ordered) {
    const key = stationKey(s)
    const fav = state.favorites.includes(key)
    const v = valueFor(s)
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML =
      `<img class="sym" src="${BASE}/symbols/${iconFor(s)}.svg" alt="">` +
      `<div class="info"><div class="name">${esc(s.name)}</div>` +
      `<div class="sub">${s.kind === 'tide' ? 'Tide' : 'Current'} · ${nmi(s.distanceKm || 0)} nm</div></div>` +
      `<div class="val ${v.cls}">${v.text}</div>` +
      `<div class="star ${fav ? 'on' : ''}">${fav ? '★' : '☆'}</div>`
    row.querySelector('.star').addEventListener('click', (ev) => {
      ev.stopPropagation()
      toggleFavorite(key)
      renderList()
    })
    row.addEventListener('click', () => openDetail(s))
    el.appendChild(row)
  }
  $('status').textContent =
    `${state.stations.length} stations within ${state.cfg.radiusNm || ''} nm`.replace(
      '  ',
      ' '
    )
}

// ---------------------------------------------------------------- detail

async function openDetail(s) {
  state.sel = s
  state.dayOffset = 0
  state.detailsOpen = false
  $('details-table').hidden = true
  $('details-btn').classList.remove('active')
  $('list-view').hidden = true
  $('detail-view').hidden = false
  $('detail-name').textContent = s.name
  updateFavBtn()
  await loadForecast()
}

function closeDetail() {
  state.sel = null
  $('detail-view').hidden = true
  $('list-view').hidden = false
  refreshList()
}

function updateFavBtn() {
  const on = state.sel && state.favorites.includes(stationKey(state.sel))
  const b = $('fav-btn')
  b.textContent = on ? '★' : '☆'
  b.classList.toggle('on', !!on)
}

async function loadForecast() {
  const s = state.sel
  if (!s) return
  // Stale-response guard: back/away or rapid day-paging while a slow fetch
  // is in flight must not render the old response (or crash on a null sel).
  const token = ++loadForecastToken
  const { start, end } = dayBounds(state.dayOffset)
  $('day-label').textContent =
    state.dayOffset === 0 ? `Today · ${fmtDay(start)}` : fmtDay(start)
  $('scrub-readout').textContent = '…'
  let forecast = null
  try {
    if (s.kind === 'tide') {
      const [src, sid] = s.id.split('/')
      forecast = await getJSON(
        `${BASE}/api/tide/${encodeURIComponent(src)}/${encodeURIComponent(sid)}?start=${start.toISOString()}&end=${end.toISOString()}`
      )
    } else {
      forecast = await getJSON(
        `${BASE}/api/current/${encodeURIComponent(s.id)}?start=${start.toISOString()}&end=${end.toISOString()}`
      )
    }
  } catch (err) {
    if (token === loadForecastToken && state.sel === s) {
      state.forecast = null
      $('scrub-readout').textContent = `Load failed: ${err.message}`
    }
    return
  }
  if (token !== loadForecastToken || state.sel !== s) {
    return // superseded by a newer selection/day
  }
  state.forecast = forecast
  // default the scrub position to "now" when today is shown
  state.scrubIdx = null
  renderForecast()
  renderStateBadge()
  if (state.detailsOpen) renderDetailsTable()
}

function seriesPoints() {
  const f = state.forecast
  if (!f) return []
  if (state.sel.kind === 'tide') {
    return (f.timeline || []).map((p) => ({
      time: new Date(p.time),
      v: p.level
    }))
  }
  return (f.series || []).map((p) => ({ time: new Date(p.time), v: p.v }))
}

function scrubIndexForNow(pts) {
  const now = Date.now()
  let best = 0
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].time - now) < Math.abs(pts[best].time - now)) best = i
  }
  return best
}

function renderStateBadge() {
  const s = state.sel
  const el = $('detail-state')
  el.className = 'statebadge'
  if (!s) return
  if (s.kind === 'tide') {
    const f = state.forecast
    const st = f && f.now ? f.now.state : s.state
    const h = f && f.now ? f.now.heightM : s.heightM
    el.classList.add(st || '')
    el.textContent =
      st === 'rising'
        ? `▲ Rising · now ${fmtHeight(h)}`
        : st === 'falling'
          ? `▼ Falling · now ${fmtHeight(h)}`
          : '—'
  } else {
    el.classList.add('cur')
    const n = state.forecast && state.forecast.now
    el.textContent = !n
      ? 'No prediction data'
      : n.phase === 'slack'
        ? '◦ Slack water'
        : `${n.phase === 'flood' ? 'Flooding' : 'Ebbing'} · ${n.speed.toFixed(1)} kn` +
          (n.dir != null ? ` → ${Math.round(n.dir)}°T` : '')
  }
}

// ------------------------------------------------------------ graph drawing

const G = { w: 360, h: 170, l: 36, r: 8, t: 14, b: 20 }

function renderForecast() {
  const svg = $('graph')
  const pts = seriesPoints()
  if (pts.length < 2) {
    svg.innerHTML =
      '<text x="180" y="85" text-anchor="middle" fill="#999" font-size="13">no data</text>'
    $('scrub').disabled = true
    return
  }
  $('scrub').disabled = false
  $('scrub').max = String(pts.length - 1)
  if (state.scrubIdx == null) {
    state.scrubIdx =
      state.dayOffset === 0 ? scrubIndexForNow(pts) : Math.floor(pts.length / 2)
  }
  $('scrub').value = String(state.scrubIdx)

  const isTide = state.sel.kind === 'tide'
  const conv = (v) =>
    isTide && state.cfg.units === 'ft' ? v * M_TO_FT : v
  const t0 = pts[0].time.getTime()
  const t1 = pts[pts.length - 1].time.getTime()
  const vals = pts.map((p) => conv(p.v))
  let min = Math.min(...vals)
  let max = Math.max(...vals)
  if (!isTide) {
    // symmetric around zero so the flood/ebb axis is centred
    max = Math.max(0.5, Math.max(Math.abs(min), Math.abs(max))) * 1.15
    min = -max
  } else {
    const span = Math.max(max - min, 0.5)
    min -= span * 0.12
    max += span * 0.12
  }
  const x = (t) => G.l + ((t - t0) / (t1 - t0)) * (G.w - G.l - G.r)
  const y = (v) => G.t + (1 - (v - min) / (max - min)) * (G.h - G.t - G.b)

  const line = pts
    .map((p) => `${x(p.time.getTime()).toFixed(1)},${y(conv(p.v)).toFixed(1)}`)
    .join(' ')
  const baseY = isTide ? G.h - G.b : y(0)
  const stroke = isTide
    ? state.forecast && state.forecast.now && state.forecast.now.state === 'falling'
      ? 'var(--falling)'
      : 'var(--rising)'
    : 'var(--current)'

  let parts = ''
  parts += `<polygon points="${G.l},${baseY} ${line} ${G.w - G.r},${baseY}" fill="${stroke}" opacity="0.15"/>`
  parts += `<polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="2"/>`
  parts += `<line x1="${G.l}" y1="${baseY}" x2="${G.w - G.r}" y2="${baseY}" stroke="#999" stroke-width="1"/>`

  // hour ticks (every 4h)
  for (let t = t0; t <= t1; t += 4 * 3600 * 1000) {
    const lbl = new Date(t)
      .toLocaleTimeString([], { hour: 'numeric' })
      .replace(' ', '')
      .toLowerCase()
    parts += `<text x="${x(t).toFixed(1)}" y="${G.h - 5}" font-size="9" fill="#8a8a8a" text-anchor="middle">${lbl}</text>`
  }
  // y labels
  parts += `<text x="4" y="${(y(max) + 9).toFixed(1)}" font-size="9" fill="#8a8a8a">${max.toFixed(1)}</text>`
  parts += `<text x="4" y="${(y(min) - 2).toFixed(1)}" font-size="9" fill="#8a8a8a">${min.toFixed(1)}</text>`

  // extreme markers (tide) / event markers (current)
  if (isTide && state.forecast.extremes) {
    for (const e of state.forecast.extremes) {
      const ex = x(new Date(e.time).getTime())
      const ey = y(conv(e.level))
      parts += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2.6" fill="${stroke}"/>`
      parts += `<text x="${ex.toFixed(1)}" y="${(e.type === 'High' ? ey - 6 : ey + 12).toFixed(1)}" font-size="9" fill="#8a8a8a" text-anchor="middle">${fmtTime(e.time)}</text>`
    }
  }

  // "now" marker when the window covers it
  const now = Date.now()
  if (now >= t0 && now <= t1) {
    parts += `<line x1="${x(now).toFixed(1)}" y1="${G.t}" x2="${x(now).toFixed(1)}" y2="${G.h - G.b}" stroke="#e53935" stroke-width="1.5" stroke-dasharray="3,2"/>`
  }

  // scrub cursor
  const sp = pts[state.scrubIdx]
  if (sp) {
    const sx = x(sp.time.getTime())
    const sy = y(conv(sp.v))
    parts += `<line x1="${sx.toFixed(1)}" y1="${G.t}" x2="${sx.toFixed(1)}" y2="${G.h - G.b}" stroke="var(--accent, #0b69c7)" stroke-width="1"/>`
    parts += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="4" fill="var(--accent, #0b69c7)"/>`
  }
  svg.innerHTML = parts
  renderScrubReadout()
}

function renderScrubReadout() {
  const pts = seriesPoints()
  const p = pts[state.scrubIdx]
  if (!p) {
    $('scrub-readout').textContent = ''
    return
  }
  if (state.sel.kind === 'tide') {
    $('scrub-readout').textContent = `${fmtTime(p.time)} · ${fmtHeight(p.v)}`
  } else {
    const phase = p.v > 0.1 ? 'flood' : p.v < -0.1 ? 'ebb' : 'slack'
    $('scrub-readout').textContent =
      `${fmtTime(p.time)} · ${Math.abs(p.v).toFixed(1)} kn ${phase}`
  }
}

// ------------------------------------------------------------ details table

function renderDetailsTable() {
  const el = $('details-table')
  const f = state.forecast
  if (!f) {
    el.innerHTML = '<div class="empty">No data.</div>'
    return
  }
  if (state.sel.kind === 'tide') {
    const rows = (f.extremes || [])
      .map(
        (e) =>
          `<tr><td>${e.type}</td><td>${fmtTime(e.time)}</td><td>${fmtHeight(e.level)}</td></tr>`
      )
      .join('')
    // hourly heights give the "changes over time" table under the extremes
    const pts = seriesPoints().filter((_, i) => i % 6 === 0) // 10-min -> hourly
    const hourly = pts
      .map(
        (p) =>
          `<tr><td>—</td><td>${fmtTime(p.time)}</td><td>${fmtHeight(p.v)}</td></tr>`
      )
      .join('')
    el.innerHTML =
      `<table><tr><th>Event</th><th>Time</th><th>Height</th></tr>${rows}</table>` +
      `<table style="margin-top:8px"><tr><th></th><th>Hour</th><th>Height</th></tr>${hourly}</table>`
  } else {
    const rows = (f.events || [])
      .map((e) => {
        const what =
          e.type === 'slack'
            ? 'Slack'
            : e.type === 'flood'
              ? 'Max Flood'
              : 'Max Ebb'
        const v = e.type === 'slack' ? '—' : `${Math.abs(e.v).toFixed(1)} kn`
        const d = e.type === 'flood' ? e.floodDir : e.ebbDir
        const dir = e.type === 'slack' || d == null ? '' : `${Math.round(d)}°T`
        return `<tr><td>${what}</td><td>${fmtTime(e.time)}</td><td>${v}</td><td>${dir}</td></tr>`
      })
      .join('')
    el.innerHTML = `<table><tr><th>Event</th><th>Time</th><th>Speed</th><th>Dir</th></tr>${rows}</table>`
  }
}

// ------------------------------------------------------------ layer toggle

async function toggleLayer() {
  if (!state.client) return
  try {
    if (state.layerHidden) {
      await state.client.call('resources.clearFilter', { type: 'notes' })
      state.layerHidden = false
    } else {
      await state.client.call('resources.setFilter', {
        type: 'notes',
        filter: {
          mode: 'exclude',
          match: [
            {
              path: 'properties.plugin',
              op: 'eq',
              value: 'signalk-tide-stations'
            }
          ],
          label: 'Tide/current stations hidden'
        }
      })
      state.layerHidden = true
    }
  } catch {
    /* host without resources.filter */
  }
  $('layer-btn').classList.toggle('off', state.layerHidden)
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('refresh-btn').addEventListener('click', refreshList)
  $('layer-btn').addEventListener('click', toggleLayer)
  $('back-btn').addEventListener('click', closeDetail)
  $('fav-btn').addEventListener('click', () => {
    if (!state.sel) return
    toggleFavorite(stationKey(state.sel))
    updateFavBtn()
  })
  $('day-prev').addEventListener('click', () => {
    if (state.dayOffset > -1) {
      state.dayOffset--
      loadForecast()
    }
  })
  $('day-next').addEventListener('click', () => {
    if (state.dayOffset < 6) {
      state.dayOffset++
      loadForecast()
    }
  })
  $('scrub').addEventListener('input', (ev) => {
    state.scrubIdx = Number(ev.target.value)
    renderForecast()
  })
  $('details-btn').addEventListener('click', () => {
    state.detailsOpen = !state.detailsOpen
    $('details-table').hidden = !state.detailsOpen
    $('details-btn').classList.toggle('active', state.detailsOpen)
    if (state.detailsOpen) renderDetailsTable()
  })
  $('goto-btn').addEventListener('click', async () => {
    const s = state.sel
    if (!s || !state.client) return
    try {
      await state.client.call('map.center', {
        position: [s.longitude, s.latitude],
        zoom: 14
      })
    } catch {
      /* host without map capability */
    }
  })

  // swipe on the graph pages days (Garmin's "swipeable bar over time")
  let touchX = null
  const wrap = $('graph-wrap')
  wrap.addEventListener('touchstart', (ev) => {
    touchX = ev.touches[0].clientX
  })
  wrap.addEventListener('touchend', (ev) => {
    if (touchX == null) return
    const dx = ev.changedTouches[0].clientX - touchX
    touchX = null
    if (Math.abs(dx) < 50) return
    if (dx < 0 && state.dayOffset < 6) {
      state.dayOffset++
      loadForecast()
    } else if (dx > 0 && state.dayOffset > -1) {
      state.dayOffset--
      loadForecast()
    }
  })
}

async function main() {
  wire()
  // Bus connect can hang forever outside a host; cap it.
  try {
    state.client = await Promise.race([
      connectExtension(),
      new Promise((r) => setTimeout(() => r(null), 3000))
    ])
  } catch {
    state.client = null
  }
  if (!state.client) {
    $('layer-btn').style.display = 'none'
    $('goto-btn').style.display = 'none'
  } else {
    // The user can clear our display filter from the host's own chip; track
    // it so the toggle button never inverts relative to reality.
    try {
      await state.client.subscribe(['filters.changed'], (ev) => {
        if (ev && ev.type === 'notes') {
          state.layerHidden = !!ev.active
          $('layer-btn').classList.toggle('off', state.layerHidden)
        }
      })
    } catch {
      /* host without resources.filter */
    }
  }
  try {
    const cfg = await getJSON(`${BASE}/api/config`)
    Object.assign(state.cfg, cfg)
  } catch {
    /* defaults */
  }
  await loadFavorites()
  await refreshList()

  // keep things live: list every 5 min, "now" markers every minute
  setInterval(() => {
    if (!$('list-view').hidden) refreshList()
  }, 5 * 60 * 1000)
  setInterval(() => {
    if (!$('detail-view').hidden && state.dayOffset === 0) renderForecast()
  }, 60 * 1000)
}

main()
