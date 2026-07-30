# signalk-tide-stations

Garmin-style **tide & current stations** on [Freeboard-SK](https://github.com/SignalK/freeboard-sk) charts, as a Signal K server plugin.

- **Tide station markers** on the chart whose **level indication tracks the live water level** within the current cycle (21 pre-rendered 5% steps per state). **Blue while rising, red while falling** (the Garmin state colours). State is derived from the harmonic prediction curve: next extreme is a High → rising (same rule signalk-tides and OpenCPN use). When the level can't be normalised honestly (missing extremes, micro-tidal range) the marker drops the level element and shows a grey "no reading" dash — never a fake full or empty gauge.
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

Enable the plugin in the Signal K admin UI (enabled by default), then **reload Freeboard-SK** (symbols are discovered at startup). Configuration: **tide icon style**, **current icon style**, **marker size**, search radius (nm), height units (ft/m), show/hide currents, station count caps.

## Icon styles

Pick the tide marker style in Plugin Config. All styles keep blue = rising / red = falling, and all except `arrow` show the live water level.

| `tideIconStyle` | Looks like |
| --- | --- |
| `gauge` *(default)* | Rounded badge, coloured outline, fill bar rising with the level. |
| `staff` | Slim vertical tide staff with graduations; water fills from the bottom. Narrowest footprint. |
| `ring` | Circular badge; an arc sweeps clockwise from 12 o'clock in proportion to the level. |
| `pin` | Teardrop pin that fills to the level and whose tip points exactly at the station. |
| `dial` | Clock face whose needle makes one clockwise turn per tide cycle — straight down at low water, straight up at high water. |
| `arrow` | Solid coloured badge with only an up/down arrow. No level, least visual noise. |

| `currentIconStyle` | Looks like |
| --- | --- |
| `scaled` *(default)* | Three arrow weights by speed (<1 kn / 1–2 kn / ≥2 kn). |
| `uniform` | One arrow weight for every speed — direction only; speed stays in the label. |

`iconSize` (`small` / `normal` / `large`) scales every marker.

**Every style is pre-generated**, so switching styles needs no regeneration: change the dropdown and the new icons appear at the next chart notes refresh (pan/zoom). Freeboard discovers symbols only at startup, so the *first* Freeboard load after installing/upgrading the plugin has to happen before any style is selectable — and `iconSize`, which is baked into the symbol catalogue, always needs a Freeboard reload.

To add a style, add it to `TIDE_STYLES` in `plugin/icon-styles.js` and a draw function in `tools/generate-symbols.js`, then run `node tools/generate-symbols.js` (it cross-checks the drawings against the catalogue and fails on a mismatch).

## Freeboard-SK 3.0.1: the note-label patch

**Stock Freeboard-SK 3.0.1 never draws note labels at all.** It's an upstream
regression: the `<fb-notes>` element in `fb-map.component.html` is missing the
`[mapZoom]` / `[labelMinZoom]` bindings that every other resource layer has, and
`updateLabels()` is driven only by those inputs. Without them the marker text
("4.3ft▲ Bald Head") can never appear, whatever `mapLabel` is set to.

Until that is fixed upstream, patch the installed bundle:

```sh
python3 tools/patch-freeboard-note-labels.py            # apply
python3 tools/patch-freeboard-note-labels.py --revert   # undo
```

Then reload Freeboard-SK. The script is idempotent, keeps a `.pre-tide-labels`
backup next to the chunk it edits, and only labels notes carrying
`properties.plugin === "signalk-tide-stations"` — other plugins' notes are
untouched.

⚠ **Re-run it after every Freeboard-SK update.** An update restores the stock
bundle (and changes the compiled chunk name), silently removing your labels.

The proper fix is a two-line upstream PR adding the missing bindings, which
would retire this script entirely.

## Requirements

- Signal K server ≥ 2.x (resource provider API, v2 resources).
- Freeboard-SK ≥ 2.24 (custom symbol support); ≥ 3.0 for the plotter-extension panel.
- Freeboard-SK 3.0.1 additionally needs the note-label patch above for marker
  labels to render.

## Notes

- Station markers are published as read-only Signal K `notes`; any client that renders notes shows them (icons/labels need a symbols-aware client such as Freeboard-SK).
- Marker state refreshes each time the chart re-queries notes (pan/zoom or the periodic position-follow refresh). The panel refreshes itself every 5 minutes.
- The panel hides the station layer via a Freeboard display filter (the chip in Freeboard's UI clears it too).
