/* converter.js - Bidirectional unit conversion logic */
(function () {
  // Classify each canonical unit as metric or imperial for unitSystem preference filtering
  const UNIT_SYSTEM = {
    // Metric
    mm: 'metric', cm: 'metric', m: 'metric', km: 'metric',
    mg: 'metric', g: 'metric', kg: 'metric',
    ml: 'metric', l: 'metric',
    kph: 'metric', mps: 'metric',
    '°c': 'metric', kelvin: 'metric',
    l100km: 'metric', kml: 'metric',
    // Imperial
    in: 'imperial', ft: 'imperial', yd: 'imperial', mi: 'imperial',
    oz: 'imperial', lb: 'imperial', ton: 'imperial',
    tsp: 'imperial', tbsp: 'imperial', cup: 'imperial', pt: 'imperial', qt: 'imperial', gal: 'imperial', barrel: 'imperial',
    mph: 'imperial', knot: 'imperial',
    '°f': 'imperial',
    mpg: 'imperial',
  };

  // Non-linear conversions (e.g. temperature offsets)
  const CUSTOM_CONVERSIONS = {
    '°c': [
      { target: '°f',     label: null, fn: v => v * 9 / 5 + 32 },
      { target: 'kelvin', label: null, fn: v => v + 273.15 },
    ],
    '°f': [
      { target: '°c',     label: null, fn: v => (v - 32) * 5 / 9 },
      { target: 'kelvin', label: null, fn: v => (v - 32) * 5 / 9 + 273.15 },
    ],
    'kelvin': [
      { target: '°c',     label: null, fn: v => v - 273.15 },
      { target: '°f',     label: null, fn: v => (v - 273.15) * 9 / 5 + 32 },
    ],
    // Fuel efficiency (inverse relationship: MPG ↔ L/100km)
    'mpg': [
      { target: 'kml',    label: null, fn: v => v * 0.425144 },
      { target: 'l100km', label: null, fn: v => 235.215 / v },
    ],
    'l100km': [
      { target: 'mpg', label: null, fn: v => 235.215 / v },
      { target: 'kml', label: null, fn: v => 100 / v },
    ],
    'kml': [
      { target: 'mpg',    label: null, fn: v => v * 2.35215 },
      { target: 'l100km', label: null, fn: v => 100 / v },
    ],
  };

  const CONVERSION_MAP = {
    // Distance - metric to imperial
    'mm':  { target: 'in',  factor: 1 / 25.4 },
    'cm':  { target: 'in',  factor: 1 / 2.54 },
    'm':   { target: 'ft',  factor: 1 / 0.3048 },
    'km':  { target: 'mi',  factor: 1 / 1.60934 },
    // Distance - imperial to metric
    'in':  { target: 'cm',  factor: 2.54 },
    'ft':  { target: 'm',   factor: 0.3048 },
    'yd':  { target: 'm',   factor: 0.9144 },
    'mi':  { target: 'km',  factor: 1.60934 },
    // Weight - metric to imperial
    'mg':  { target: 'oz',  factor: 1 / 28349.5 },
    'g':   { target: 'oz',  factor: 1 / 28.3495 },
    'kg':  { target: 'lb',  factor: 1 / 0.453592 },
    // Weight - imperial to metric
    'lb':  { target: 'kg',  factor: 0.453592 },
    // Volume - metric to imperial
    'ml':  { target: 'cup', factor: 1 / 236.588 },
    'l':   { target: 'qt',  factor: 1.05669 },
    // Volume - imperial to metric
    'tsp':  { target: 'ml', factor: 4.92892 },
    'tbsp': { target: 'ml', factor: 14.7868 },
    'cup':  { target: 'ml', factor: 236.588 },
    'pt':   { target: 'l',  factor: 0.473176 },
    // Speed
    'kph':  { target: 'mph',  factor: 0.621371 },
    'mph':  { target: 'kph',  factor: 1.60934 },
    'mps':  { target: 'kph',  factor: 3.6 },
    'knot': { target: 'kph',  factor: 1.852 },
  };

  // Units with multiple interpretations — each entry produces multiple result rows
  const AMBIGUOUS_UNITS = {
    'oz': [
      { label: 'mass',   target: 'g',  factor: 28.3495 },
      { label: 'fluid',  target: 'ml', factor: 29.5735 },
    ],
    'ton': [
      { label: 'US',       target: 'kg', factor: 907.185 },
      { label: 'Imperial', target: 'kg', factor: 1016.05 },
    ],
    'qt': [
      { label: 'US',       target: 'l', factor: 0.946353 },
      { label: 'Imperial', target: 'l', factor: 1.13652 },
    ],
    'gal': [
      { label: 'US',       target: 'l', factor: 3.78541 },
      { label: 'Imperial', target: 'l', factor: 4.54609 },
    ],
    'barrel': [
      { label: 'US fluid', target: 'l', factor: 119.24 },
      { label: 'oil',      target: 'l', factor: 158.987 },
    ],
  };

  const UNIT_DISPLAY = {
    'mm': 'mm', 'cm': 'cm', 'm': 'm', 'km': 'km',
    'in': 'in', 'ft': 'ft', 'yd': 'yd', 'mi': 'mi',
    'mg': 'mg', 'g': 'g', 'kg': 'kg',
    'oz': 'oz', 'lb': 'lb', 'ton': 'ton',
    'ml': 'ml', 'l': 'L',
    'tsp': 'tsp', 'tbsp': 'tbsp', 'cup': 'cup', 'pt': 'pt', 'qt': 'qt', 'gal': 'gal',
    'barrel': 'bbl',
    '°c': '°C', '°f': '°F', 'kelvin': 'K',
    'kph': 'km/h', 'mph': 'mph', 'mps': 'm/s', 'knot': 'knot',
    'mpg': 'MPG', 'l100km': 'L/100km', 'kml': 'km/L',
  };

  function formatResult(result) {
    if (result === 0) return '0';
    return parseFloat(result.toFixed(2)).toString();
  }

  // When a result is < 1, step down to the next smaller unit (chain until >= 1 or no further step)
  const DOWNSCALE = {
    'kg': { unit: 'g',    factor: 1000 },
    'g':  { unit: 'mg',   factor: 1000 },
    'km': { unit: 'm',    factor: 1000 },
    'm':  { unit: 'cm',   factor: 100  },
    'cm': { unit: 'mm',   factor: 10   },
    'mi': { unit: 'ft',   factor: 5280 },
    'ft': { unit: 'in',   factor: 12   },
    'l':   { unit: 'ml',   factor: 1000 },
    'qt':  { unit: 'cup', factor: 4    },
    'cup': { unit: 'tbsp', factor: 16  },
    'tbsp':{ unit: 'tsp', factor: 3    },
  };

  function applyDownscale(result, targetUnit) {
    while (Math.abs(result) < 1 && Math.abs(result) > 0 && DOWNSCALE[targetUnit]) {
      const down = DOWNSCALE[targetUnit];
      result = result * down.factor;
      targetUnit = down.unit;
    }
    return { result, targetUnit };
  }

  function buildCustomResult(value, fn, target, label) {
    const result = fn(value);
    return {
      result,
      targetUnit: target,
      formatted: `${formatResult(result)} ${UNIT_DISPLAY[target]}`,
      label
    };
  }

  function buildResult(value, factor, target, label) {
    const ds = applyDownscale(value * factor, target);
    return {
      result: ds.result,
      targetUnit: ds.targetUnit,
      formatted: `${formatResult(ds.result)} ${UNIT_DISPLAY[ds.targetUnit]}`,
      label
    };
  }

  // Always returns an array of results, or null if unit is unknown
  function convert(value, fromUnit, settings) {
    const unitSystem = settings && settings.unitSystem || 'both';
    const temperaturePref = settings && settings.temperaturePref || 'both';
    const fuelPref = settings && settings.fuelPref || 'all';

    // Unit system filter: skip if the source unit is already the preferred system
    if (unitSystem !== 'both') {
      const srcSystem = UNIT_SYSTEM[fromUnit];
      if (unitSystem === 'metric' && srcSystem === 'metric') return null;
      if (unitSystem === 'imperial' && srcSystem === 'imperial') return null;
    }

    const custom = CUSTOM_CONVERSIONS[fromUnit];
    if (custom) {
      let results = custom.map(c => buildCustomResult(value, c.fn, c.target, c.label));

      // Filter temperature results to preferred unit
      if ((fromUnit === '°c' || fromUnit === '°f' || fromUnit === 'kelvin') && temperaturePref !== 'both') {
        results = results.filter(r => r.targetUnit === temperaturePref);
      }

      // Filter fuel results to preferred unit
      const fuelUnits = ['mpg', 'l100km', 'kml'];
      if (fuelUnits.includes(fromUnit) && fuelPref !== 'all') {
        results = results.filter(r => r.targetUnit === fuelPref);
      }

      return results.length ? results : null;
    }

    const ambiguous = AMBIGUOUS_UNITS[fromUnit];
    if (ambiguous) {
      return ambiguous.map(a => buildResult(value, a.factor, a.target, a.label));
    }

    const mapping = CONVERSION_MAP[fromUnit];
    if (!mapping) return null;

    return [buildResult(value, mapping.factor, mapping.target, null)];
  }

  window.UnitConverter = { convert, UNIT_SYSTEM };
})();
