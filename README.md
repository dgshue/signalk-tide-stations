# signalk-tide-stations

Garmin-style **tide & current stations** on [Freeboard-SK](https://github.com/SignalK/freeboard-sk) charts, as a Signal K server plugin.

- **Tide station gauges** on the chart: a light badge — white body, coloured outline — whose **fill level tracks the live water level** within the current cycle (near-empty at low water, near-full at high water; 21 pre-rendered 5% fill steps per state). **Blue + up-arrow while rising, red + down-arrow while falling** (the Garmin state colours). State is derived from the harmonic prediction curve: next extreme is a High → rising (same rule signalk-tides and OpenCPN use). When the level can't be normalised honestly (missing extremes, micro-tidal range) the badge falls back to arrow-only — never a fake fill.
- **Current station arrows** rotated to the predicted set (16 pre-rendered 22.5° sectors) and **weighted by speed**: thin pale arrow under 1 kn, standard OpenCPN-orange 1–2 kn, fat deep-orange at 2 kn and above (quantizing OpenCPN's "bigger arrow = more current" continuous scaling), with slack shown as a ring.
- **Values at zoom**: the marker label ("2.9ft▲ Southport", "1.2kn Snows Cut") appears once the map zoom passes Freeboard's *labels* threshold — zoom in and the numbers appear, Garmin-style.
- **Tap an icon** → Freeboard's note panel opens with a **forecast graph for right now** (server-rendered SVG), the next highs/lows (or max flood/ebb/slack events) and a NOAA link.
- **Toolbar button (🌊) → forecast panel** (plotter extension): nearby stations sorted by distance, ★ **favorites** (persisted), tide/current **graph with a scrubbable + swipeable time bar**, day paging (yesterday … +6 days), a **Details** table, and *Show on chart*.

## Data sources

- **Tides**: computed **offline** from harmonic constituents by [`neaps`](https://github.com/openwatersio/neaps) — the same engine `signalk-tides` uses, so numbers agree with your `environment.tide.*` paths. No network needed.
- **Currents**: NOAA CO-OPS current predictions (metadata + tabulated max/slack events), fetched over the internet and cached on disk (about a week of predictions per station), with cosine interpolation between events — the classic xtide/OpenCPN rule for subordinate stations. Offline, cached predictions keep working until they run out.

## Install

```sh
cd ~/.signalk
npm install signalk-tide-stations   # or: npm install /path/to/checkout
```

Enable the plugin in the Signal K admin UI (enabled by default), then **reload Freeboard-SK** (symbols are discovered at startup). Configuration: search radius (nm), height units (ft/m), show/hide currents, station count caps.

## Requirements

- Signal K server ≥ 2.x (resource provider API, v2 resources).
- Freeboard-SK ≥ 2.24 (custom symbol support); ≥ 3.0 for the plotter-extension panel.

## Notes

- Station markers are published as read-only Signal K `notes`; any client that renders notes shows them (icons/labels need a symbols-aware client such as Freeboard-SK).
- Marker state refreshes each time the chart re-queries notes (pan/zoom or the periodic position-follow refresh). The panel refreshes itself every 5 minutes.
- The panel hides the station layer via a Freeboard display filter (the chip in Freeboard's UI clears it too).
