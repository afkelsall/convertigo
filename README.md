# Convertigo

A Firefox extension that instantly converts units and currencies in selected text. Spiritual successor to the deprecated AutoConvert extension — rebuilt from scratch.

Select any text containing measurements or currency amounts and a popup appears with conversions. Detected values are also highlighted directly on the page with hover-to-convert.

![Firefox](https://img.shields.io/badge/Firefox-Manifest_V2-FF7139?logo=firefox-browser&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **Select to convert** — highlight text containing units or currencies and get instant conversions in a top-right popup
- **Page scanning** — detected measurements are underlined on the page; hover to see conversions inline
- **Smart number parsing** — decimals (`2.5 m`), fractions (`3/4 in`), mixed numbers (`1 1/2 cups`), comma decimals (`2,5 kg`), ranges (`2-3 inches`), and dimensions (`13 x 72 inches`)
- **Compound feet/inches** — `5'10"` is parsed and converted as a single measurement
- **Ambiguous units** — units like `oz`, `ton`, `gallon`, and `barrel` show all interpretations (e.g. mass vs fluid, US vs Imperial)
- **Auto-downscaling** — `0.5 kg` displays as `500 g` for readability
- **Live currency rates** — powered by [Frankfurter](https://frankfurter.dev/), updated daily
- **Multiplier support** — handles `$350K`, `$7.3 billion`, `€1.5M`
- **Reconstructed text** — when multiple measurements are found, shows the full text with all conversions applied inline
- **Copy as JSON** — export conversions as test fixture data from the popup

## Supported Conversions

### Units

| Category | Metric | Imperial |
|----------|--------|----------|
| **Distance** | mm, cm, m, km | in, ft, yd, mi |
| **Weight** | mg, g, kg | oz, lb, ton |
| **Volume** | ml, L | tsp, tbsp, cup, pt, qt, gal, barrel |

Full word forms (`inches`, `feet`, `pounds`, `litres`, etc.) and symbols (`"`, `″`, `'`) are supported.

### Currencies

Converts 31 currencies to AUD: USD, EUR, GBP, JPY, CAD, CHF, CNY, HKD, NZD, SGD, SEK, NOK, DKK, KRW, INR, MXN, BRL, ZAR, THB, PLN, CZK, HUF, ILS, IDR, MYR, PHP, RON, BGN, ISK, TRY, AUD.

Recognizes symbols (`$`, `€`, `£`, `¥`), currency codes before/after amounts (`USD 50`, `50 EUR`), and country-prefixed dollars (`US$`, `C$`, `AU$`).

## Installation

1. Clone this repository
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select the `manifest.json` file

## Running Tests

```bash
node tests/run.js
```

Tests cover unit parsing, currency parsing, and currency conversion with 86+ test cases.

## Project Structure

```
convertigo/
├── manifest.json              # Extension manifest (Manifest V2)
├── background/
│   └── background.js          # Currency rate fetching & caching
├── content/
│   ├── content.js             # Selection listener, popup lifecycle, page scanning
│   └── content.css            # Popup & highlight styling (dark theme)
├── lib/
│   ├── parser.js              # Regex-based unit detection from text
│   ├── converter.js           # Unit conversion with auto-downscaling
│   ├── currency-parser.js     # Currency amount detection
│   └── currency-converter.js  # Currency conversion logic
├── icons/
│   ├── icon-48.png
│   └── icon-96.png
└── tests/
    ├── run.js                 # Test runner
    ├── fixtures.json          # Unit test cases
    ├── currency-fixtures.json # Currency parser test cases
    └── currency-conversion-fixtures.json
```

## Adding New Units

No regex editing needed. Add entries to `UNIT_ALIASES`/`SYMBOL_UNITS` in `lib/parser.js` and `CONVERSION_MAP`/`DOWNSCALE` in `lib/converter.js` — patterns are auto-generated at load time.

## License

[MIT](LICENSE)
