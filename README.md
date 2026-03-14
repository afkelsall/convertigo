# Convertigo

A Firefox extension that instantly converts units and currencies in selected text. Spiritual successor to the deprecated AutoConvert extension — rebuilt from scratch.

Select any text containing measurements or currency amounts and a popup appears with conversions. Detected values are also highlighted directly on the page with hover-to-convert.

![Firefox](https://img.shields.io/badge/Firefox-Manifest_V2-FF7139?logo=firefox-browser&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **Select to convert** — highlight text containing units or currencies and get instant conversions in a top-right popup
- **Page scanning** — detected measurements are underlined on the page; hover to see conversions inline
- **Hold-key replace** — hold Alt (configurable) to temporarily replace all measurements on the page with converted values; or enable permanent replace to always show converted values
- **Smart number parsing** — decimals (`2.5 m`), fractions (`3/4 in`), mixed numbers (`1 1/2 cups`), comma decimals (`2,5 kg`), ranges (`2-3 inches`), and dimensions (`13 x 72 inches`)
- **Compound feet/inches** — `5'10"` parsed and converted as a single measurement; ranges like `5'6-5'9"` also supported
- **Ambiguous units** — `oz`, `ton`, `qt`, `gal`, and `barrel` show all interpretations (e.g. mass vs fluid, US vs Imperial)
- **Auto-downscaling** — `0.5 kg` displays as `500 g` for readability
- **Live currency rates** — powered by [Frankfurter](https://frankfurter.dev/), updated daily
- **Multiplier support** — handles `$350K`, `$7.3 billion`, `€1.5M`
- **Reconstructed text** — when multiple measurements are found, shows the full text with all conversions applied inline
- **Copy as JSON** — export conversions as test fixture data from the popup
- **Configurable settings** — unit system filter, temperature preference, fuel efficiency preference, target currency, and page behavior options

## Supported Conversions

### Units

| Category | Units |
|----------|-------|
| **Distance** | mm, cm, m, km ↔ in, ft, yd, mi |
| **Weight** | mg, g, kg ↔ oz, lb, ton |
| **Volume** | ml, L ↔ tsp, tbsp, cup, pt, qt, gal, bbl |
| **Temperature** | °C ↔ °F ↔ K |
| **Speed** | km/h ↔ mph, m/s, knot |
| **Fuel efficiency** | MPG ↔ L/100km ↔ km/L |

Full word forms (`inches`, `feet`, `pounds`, `litres`, etc.) and symbols (`"`, `″`, `'`) are supported.

### Currencies

Converts between 31 currencies: USD, EUR, GBP, JPY, CAD, CHF, CNY, HKD, NZD, SGD, SEK, NOK, DKK, KRW, INR, MXN, BRL, ZAR, THB, PLN, CZK, HUF, ILS, IDR, MYR, PHP, RON, BGN, ISK, TRY, AUD.

Recognizes symbols (`$`, `€`, `£`, `¥`), currency codes before/after amounts (`USD 50`, `50 EUR`), country-prefixed dollars (`US$`, `C$`, `AU$`), and multipliers (`$1.5M`, `€350K`, `$7 billion`). The target currency is configurable (defaults to AUD).

## Settings

Accessible via the toolbar icon:

- **Target currency** — which currency to convert amounts into
- **Unit system** — show only metric→imperial, only imperial→metric, or both directions
- **Temperature** — show only °C, only °F, or both
- **Fuel efficiency** — show only MPG, L/100km, km/L, or all
- **Page scanning** — enable/disable underlining measurements on the page
- **Hover conversions** — enable/disable inline hover tooltips
- **Hold-key replace** — key to hold (Alt / Ctrl / Shift) to replace page values with conversions
- **Permanent replace** — always show converted values on the page without holding a key

## Installation

1. Clone this repository
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select the `manifest.json` file

## Running Tests

```bash
node tests/run.js
```

## Adding New Units

No regex editing needed. Add entries to `UNIT_ALIASES`/`SYMBOL_UNITS` in `lib/parser.js` and `CONVERSION_MAP`/`DOWNSCALE` in `lib/converter.js` — patterns are auto-generated at load time.

## License

[MIT](LICENSE)
