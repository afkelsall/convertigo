# Convertigo - A Unit Converter - Firefox Extension

Firefox Manifest V2 extension that detects measurement units in selected text and shows metric↔imperial conversions in a top-right popup.

## Structure
- `manifest.json` - Extension config, loads content scripts on all URLs
- `lib/parser.js` - Regex-based unit detection from text (decimals, fractions, mixed numbers like "1 1/2", `"` as inch symbol)
- `lib/converter.js` - Bidirectional conversion with auto-downscale (e.g. 0.5 kg → 500 g)
- `content/content.js` - Selection listener (mouseup/keyup), popup DOM injection/lifecycle
- `content/content.css` - Popup styling (fixed top-right, dark theme, `uc-` prefixed classes, z-index max)

## Key details
- No background script; everything runs as content scripts
- Popup stays open while text is selected, closes on deselect
- Supports distance (mm/cm/m/km/in/ft/yd/mi) and weight (mg/g/kg/oz/lb/ton)
- Scripts load in order: parser → converter → content
- Test by loading as temporary add-on via `about:debugging`

## Adding units
- Parser regex is auto-generated from `UNIT_ALIASES` (word units) and `SYMBOL_UNITS` (symbol units like `"`) in `lib/parser.js`. Keys are sorted longest-first at load time to prevent partial matches. To add a new unit, add entries to these maps and to `CONVERSION_MAP`/`DOWNSCALE` in `lib/converter.js` — no regex editing needed.

## Unit tests
**Every regex changes requires test cases for each permutation**
**Any reported issue should have a test added as well as edge cases**

## Currency conversion
- Uses https://frankfurter.dev/ a free API, dates in UTC, updated daily at least.