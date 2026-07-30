// Server-rendered SVG forecast curves, embedded in note popups via <img>
// (Angular's sanitizer strips inline SVG from note descriptions, but an
// <img src="..."> pointing at a same-origin SVG endpoint renders fine).
//
// Deliberately small & dependency-free: polyline + area fill + labels.
'use strict'

const W = 360
const H = 150
const PAD = { l: 34, r: 8, t: 14, b: 18 }

const M_TO_FT = 3.28084

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;'
  })[c])
}

function fmtHour(date, tz) {
  const opts = { hour: 'numeric' }
  if (tz) opts.timeZone = tz
  return new Intl.DateTimeFormat('en-US', opts)
    .format(date)
    .replace(' ', '')
    .toLowerCase()
}

/**
 * Tide curve for a time window.
 * @param {object} o
 * @param {{time:Date,level:number}[]} o.timeline
 * @param {{time:Date,level:number,type:string}[]} o.extremes
 * @param {'ft'|'m'} o.units
 * @param {string} o.tz station timezone
 * @param {Date} [o.now] draw a "now" marker when inside the window
 * @param {'rising'|'falling'|null} [o.state] colours the curve fill
 */
function tideSvg({ timeline, extremes, units, tz, now, state }) {
  if (!timeline || timeline.length < 2) {
    return emptySvg('no tide data')
  }
  const conv = (m) => (units === 'ft' ? m * M_TO_FT : m)
  const t0 = timeline[0].time.getTime()
  const t1 = timeline[timeline.length - 1].time.getTime()
  const levels = timeline.map((p) => conv(p.level))
  let min = Math.min(...levels)
  let max = Math.max(...levels)
  const span = Math.max(max - min, 0.5)
  min -= span * 0.12
  max += span * 0.12
  const x = (t) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r)
  const y = (v) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b)

  const pts = timeline
    .map((p) => `${x(p.time.getTime()).toFixed(1)},${y(conv(p.level)).toFixed(1)}`)
    .join(' ')
  const areaPts = `${PAD.l},${H - PAD.b} ${pts} ${W - PAD.r},${H - PAD.b}`

  // Curve colour follows the tide state like the marker does.
  const stroke = state === 'falling' ? '#d0342c' : '#0b69c7'
  const fill = state === 'falling' ? '#d0342c22' : '#0b69c722'

  // x-axis hour ticks every 4 hours
  let ticks = ''
  for (let t = t0; t <= t1; t += 4 * 3600 * 1000) {
    ticks += `<text x="${x(t).toFixed(1)}" y="${H - 4}" font-size="9" fill="#8a8a8a" text-anchor="middle">${esc(fmtHour(new Date(t), tz))}</text>`
  }
  // y-axis min/max labels
  const yl =
    `<text x="4" y="${(y(max - span * 0.12) + 4).toFixed(1)}" font-size="9" fill="#8a8a8a">${(max - span * 0.12).toFixed(1)}</text>` +
    `<text x="4" y="${(y(min + span * 0.12) + 4).toFixed(1)}" font-size="9" fill="#8a8a8a">${(min + span * 0.12).toFixed(1)}</text>`

  // high/low markers
  let hl = ''
  for (const e of extremes || []) {
    const ex = x(e.time.getTime())
    const ey = y(conv(e.level))
    const above = e.type === 'High'
    hl +=
      `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2.5" fill="${stroke}"/>` +
      `<text x="${ex.toFixed(1)}" y="${(above ? ey - 6 : ey + 12).toFixed(1)}" font-size="9" fill="#555" text-anchor="middle">${conv(e.level).toFixed(1)} ${esc(fmtHour(e.time, tz))}</text>`
  }

  // now marker
  let nowLine = ''
  if (now) {
    const nt = now.getTime()
    if (nt >= t0 && nt <= t1) {
      nowLine = `<line x1="${x(nt).toFixed(1)}" y1="${PAD.t}" x2="${x(nt).toFixed(1)}" y2="${H - PAD.b}" stroke="#e53935" stroke-width="1.5" stroke-dasharray="3,2"/>`
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    `<polygon points="${areaPts}" fill="${fill}"/>` +
    `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2"/>` +
    `<line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" stroke="#cccccc"/>` +
    ticks +
    yl +
    hl +
    nowLine +
    `</svg>`
  )
}

/**
 * Current speed curve: signed knots (+flood / -ebb) around a zero axis.
 * @param {{time:Date,v:number}[]} series
 */
function currentSvg({ series, tz, now }) {
  if (!series || series.length < 2) {
    return emptySvg('no current data')
  }
  const t0 = series[0].time.getTime()
  const t1 = series[series.length - 1].time.getTime()
  const vals = series.map((p) => p.v)
  const vmax = Math.max(0.5, ...vals.map(Math.abs)) * 1.15
  const x = (t) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r)
  const y = (v) => PAD.t + (1 - (v + vmax) / (2 * vmax)) * (H - PAD.t - PAD.b)

  const pts = series
    .map((p) => `${x(p.time.getTime()).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(' ')
  const zero = y(0).toFixed(1)

  let ticks = ''
  for (let t = t0; t <= t1; t += 4 * 3600 * 1000) {
    ticks += `<text x="${x(t).toFixed(1)}" y="${H - 4}" font-size="9" fill="#8a8a8a" text-anchor="middle">${esc(fmtHour(new Date(t), tz))}</text>`
  }
  let nowLine = ''
  if (now) {
    const nt = now.getTime()
    if (nt >= t0 && nt <= t1) {
      nowLine = `<line x1="${x(nt).toFixed(1)}" y1="${PAD.t}" x2="${x(nt).toFixed(1)}" y2="${H - PAD.b}" stroke="#e53935" stroke-width="1.5" stroke-dasharray="3,2"/>`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    `<polygon points="${PAD.l},${zero} ${pts} ${W - PAD.r},${zero}" fill="#ff910022"/>` +
    `<polyline points="${pts}" fill="none" stroke="#ff9100" stroke-width="2"/>` +
    `<line x1="${PAD.l}" y1="${zero}" x2="${W - PAD.r}" y2="${zero}" stroke="#999999"/>` +
    `<text x="4" y="${PAD.t + 8}" font-size="9" fill="#8a8a8a">flood</text>` +
    `<text x="4" y="${H - PAD.b - 2}" font-size="9" fill="#8a8a8a">ebb</text>` +
    `<text x="4" y="${(Number(zero) - 3).toFixed(1)}" font-size="9" fill="#8a8a8a">${vmax.toFixed(1)}kn</text>` +
    ticks +
    nowLine +
    `</svg>`
  )
}

function emptySvg(msg) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    `<text x="${W / 2}" y="${H / 2}" font-size="12" fill="#999" text-anchor="middle">${esc(msg)}</text></svg>`
  )
}

module.exports = { tideSvg, currentSvg }
