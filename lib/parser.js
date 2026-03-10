/* parser.js - Unit detection from selected text */
(function () {
  const UNIT_ALIASES = {
    'mm': 'mm',
    'cm': 'cm',
    'm': 'm',
    'km': 'km',
    'in': 'in', 'inch': 'in', 'inches': 'in',
    'ft': 'ft', 'foot': 'ft', 'feet': 'ft',
    'yd': 'yd', 'yard': 'yd', 'yards': 'yd',
    'mi': 'mi', 'mile': 'mi', 'miles': 'mi',
    'mg': 'mg',
    'g': 'g',
    'kg': 'kg',
    'oz': 'oz', 'ounce': 'oz', 'ounces': 'oz',
    'lb': 'lb', 'lbs': 'lb', 'pound': 'lb', 'pounds': 'lb',
    'ton': 'ton', 'tons': 'ton',
    // Volume - metric
    'ml': 'ml',
    'l': 'l', 'liter': 'l', 'liters': 'l', 'litre': 'l', 'litres': 'l',
    // Volume - imperial
    'tsp': 'tsp', 'teaspoon': 'tsp', 'teaspoons': 'tsp',
    'tbsp': 'tbsp', 'tablespoon': 'tbsp', 'tablespoons': 'tbsp',
    'cup': 'cup', 'cups': 'cup',
    'pt': 'pt', 'pint': 'pt', 'pints': 'pt',
    'qt': 'qt', 'quart': 'qt', 'quarts': 'qt',
    'gal': 'gal', 'gallon': 'gal', 'gallons': 'gal',
    'barrel': 'barrel', 'barrels': 'barrel', 'bbl': 'barrel',
    // Temperature
    '°c': '°c', 'celsius': '°c',
    '°f': '°f', 'fahrenheit': '°f',
    'kelvin': 'kelvin',
    // Speed
    'kph': 'kph', 'kmh': 'kph', 'km/h': 'kph',
    'mph': 'mph',
    'm/s': 'mps', 'mps': 'mps',
    'knot': 'knot', 'knots': 'knot',
    // Fuel efficiency
    'l/100km': 'l100km',
    'km/l': 'kml',
    'mpg': 'mpg',
  };

  const SYMBOL_UNITS = {
    '"': 'in',
    '\u2033': 'in',   // ″
    '\u0022': 'in',   // ″
    '\'': 'ft',       // '
    '\u0027': 'ft'    // '
  };

  // Generate unit alternation from UNIT_ALIASES keys, sorted longest-first
  const unitPattern = Object.keys(UNIT_ALIASES)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .join('|');

  // Generate symbol alternation from SYMBOL_UNITS keys, regex-escaped
  const symbolPattern = Object.keys(SYMBOL_UNITS)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  // Matches: number (decimal, fraction, or mixed number like "1 1/2") + unit
  // Mixed number must come first to prevent "1" matching before "1 1/2"
  const NUMBER = '(\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?)';
  // Negative lookbehind prevents matching numbers preceded by a currency symbol, digit, or decimal point.
  // Without \d and \. exclusions, "$5.2M" would still match "2M" (since "." precedes "2", not "$").
  const UNIT_REGEX = new RegExp(
    '(?<![$€£¥\\d.])' + NUMBER + '\\s*(?:(' + unitPattern + ')\\b|(' + symbolPattern + ')([A-Za-z]?))',
    'gi'
  );

  // Matches a range: N-M unit (e.g. "2-3in", "2-3 inches")
  const SIMPLE_NUM = '(\\d+(?:[.,]\\d+)?)';
  const RANGE_REGEX = new RegExp(
    SIMPLE_NUM + '-' + SIMPLE_NUM + '\\s*(?:(' + unitPattern + ')\\b|(' + symbolPattern + ')([A-Za-z]?))',
    'gi'
  );

  // Dimension pattern: "13 x 72 inches", "13x72x5 cm", "13 × 72 in"
  const DIMENSION_REGEX = new RegExp(
    '(?<![\\d.])\\d+(?:[.,]\\d+)?(?:\\s*[x×X]\\s*\\d+(?:[.,]\\d+)?)+\\s*(?:(' + unitPattern + ')\\b|(' + symbolPattern + ')([A-Za-z]?))',
    'gi'
  );

  // Feet+inches compound: 5'10", 5'10, 5'6" etc.
  const COMPOUND_FT_IN_REGEX = new RegExp(
    "(?<!\\w)(\\d+)['\u2019\u2018](\\d+)[\"\\u2033\\u0022]?",
    'g'
  );

  // Compound range: 5'6-5'9", 5'10/5'11, 5'10"-5'11"
  const COMPOUND_RANGE_REGEX = new RegExp(
    "(?<!\\w)(\\d+)['\u2019\u2018](\\d+)[\"\\u2033\\u0022]?[-\\/](\\d+)['\u2019\u2018](\\d+)[\"\\u2033\\u0022]?",
    'g'
  );

  function parseNumber(str) {
    str = str.trim();
    if (str.includes('/')) {
      const spaceIdx = str.indexOf(' ');
      if (spaceIdx !== -1) {
        // Mixed number: "1 1/2"
        const whole = parseFloat(str.slice(0, spaceIdx));
        const [num, den] = str.slice(spaceIdx + 1).split('/').map(Number);
        return whole + num / den;
      } else {
        // Simple fraction: "1/2"
        const [num, den] = str.split('/').map(Number);
        return num / den;
      }
    }
    return parseFloat(str.replace(',', '.'));
  }

  function parse(text) {
    const results = [];
    const usedPositions = new Set();
    let match;

    // Step A: Find compound ranges first (e.g. "5'6-5'9\"", "5'10/5'11")
    COMPOUND_RANGE_REGEX.lastIndex = 0;
    while ((match = COMPOUND_RANGE_REGEX.exec(text)) !== null) {
      const feet1 = parseInt(match[1], 10);
      const inches1 = parseInt(match[2], 10);
      const feet2 = parseInt(match[3], 10);
      const inches2 = parseInt(match[4], 10);
      const val1 = feet1 * 12 + inches1;
      const val2 = feet2 * 12 + inches2;
      for (let i = match.index; i < match.index + match[0].length; i++) usedPositions.add(i);
      results.push({ value: val1, value2: val2, isRange: true, unit: 'in', original: match[0].trim(), suffix: '', index: match.index, matchLength: match[0].length });
    }

    // Step B: Find compound ft+in singles (e.g. "5'10\""), skip already-used positions
    COMPOUND_FT_IN_REGEX.lastIndex = 0;
    while ((match = COMPOUND_FT_IN_REGEX.exec(text)) !== null) {
      if (usedPositions.has(match.index)) continue;
      const feet = parseInt(match[1], 10);
      const inches = parseInt(match[2], 10);
      const value = feet * 12 + inches;
      for (let i = match.index; i < match.index + match[0].length; i++) usedPositions.add(i);
      results.push({ value, unit: 'in', original: match[0].trim(), suffix: '', index: match.index, matchLength: match[0].length });
    }

    // Step C: Find simple ranges (e.g. "2-3in", "2-3 inches"), skip used positions
    RANGE_REGEX.lastIndex = 0;
    while ((match = RANGE_REGEX.exec(text)) !== null) {
      if (usedPositions.has(match.index)) continue;
      const val1 = parseNumber(match[1]);
      const val2 = parseNumber(match[2]);
      if (isNaN(val1) || isNaN(val2)) continue;

      let unit, suffix = '', unitStr;
      if (match[3]) {
        unit = UNIT_ALIASES[match[3].toLowerCase()];
        if (!unit) continue;
        unitStr = match[3];
      } else if (match[4]) {
        unit = SYMBOL_UNITS[match[4]];
        if (!unit) continue;
        unitStr = match[4];
        suffix = match[5] || '';
      } else {
        continue;
      }

      for (let i = match.index; i < match.index + match[0].length; i++) usedPositions.add(i);

      results.push({ value: val1, value2: val2, isRange: true, unit, original: match[0].trim(), suffix, index: match.index, matchLength: match[0].length });
    }

    // Step D: Find dimension patterns (e.g. "13 x 72 inches"), skip used positions
    DIMENSION_REGEX.lastIndex = 0;
    while ((match = DIMENSION_REGEX.exec(text)) !== null) {
      if (usedPositions.has(match.index)) continue;

      let unit, suffix = '';
      if (match[1]) {
        unit = UNIT_ALIASES[match[1].toLowerCase()];
        if (!unit) continue;
      } else if (match[2]) {
        unit = SYMBOL_UNITS[match[2]];
        if (!unit) continue;
        suffix = match[3] || '';
      } else {
        continue;
      }

      for (let i = match.index; i < match.index + match[0].length; i++) usedPositions.add(i);

      // Extract all numbers from the dimension string (everything before the unit)
      const fullMatch = match[0];
      const unitStr = match[1] || match[2];
      const unitStart = fullMatch.lastIndexOf(unitStr);
      const numbersPart = fullMatch.slice(0, unitStart);
      const rawParts = numbersPart.split(/[x×X]/i).map(s => s.trim());
      const values = rawParts.map(s => parseNumber(s)).filter(n => !isNaN(n));

      results.push({ isDimension: true, values, rawValues: rawParts, unitText: unitStr, unit, original: match[0].trim(), suffix, index: match.index, matchLength: match[0].length });
    }

    // Step E: Find individual unit matches, skipping used positions
    UNIT_REGEX.lastIndex = 0;
    while ((match = UNIT_REGEX.exec(text)) !== null) {
      if (usedPositions.has(match.index)) continue;

      const value = parseNumber(match[1]);
      if (isNaN(value)) continue;

      let unit, suffix;
      if (match[2]) {
        // Standard unit keyword
        unit = UNIT_ALIASES[match[2].toLowerCase()];
        if (!unit) continue;
        suffix = '';
      } else if (match[3]) {
        // Symbol unit (e.g. " or ″ for inches)
        unit = SYMBOL_UNITS[match[3]];
        if (!unit) continue;
        suffix = match[4] || '';
      } else {
        continue;
      }

      results.push({
        value,
        unit,
        original: match[0].trim(),
        suffix,
        index: match.index,
        matchLength: match[0].length
      });
    }

    results.sort((a, b) => a.index - b.index);
    return results;
  }

  window.UnitParser = { parse };
})();
