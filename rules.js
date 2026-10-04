// The desktop app's calibration rules, worked out the same way on the phone
// (helpers.py: parse_measurement, parse_deviation, tolerance_result,
// add_inch_mark, split_leading_result, due_date_from_interval). Tests run
// both on the same cases, so a Pass here is a Pass there.
"use strict";

const Rules = (() => {
  const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;

  // '2.000"', '1.998', '.5 in' -> 2.0; anything else (fractions, '0" - 1"', N/A, blank) -> null
  function parseMeasurement(text) {
    const m = new RegExp(String.raw`^\s*(${NUMBER})\s*(?:"|in\.?|mm)?\s*$`).exec(text || "");
    return m ? parseFloat(m[1]) : null;
  }

  // '+/- .001"' or '±0.001' -> 0.001; else null
  function parseDeviation(text) {
    const m = /^\s*(?:\+\/-|\+-|±)?\s*(\d+\.?\d*|\.\d+)\s*(?:"|in\.?|mm)?\s*$/.exec(text || "");
    return m ? parseFloat(m[1]) : null;
  }

  // 'pass' / 'fail' for a reading against the range's size +/- the deviation;
  // null when they can't all be read as numbers
  function toleranceResult(nominalText, readingText, deviation) {
    const nominal = parseMeasurement(nominalText), reading = parseMeasurement(readingText);
    if (deviation === null || nominal === null || reading === null) return null;
    return Math.abs(reading - nominal) > deviation + 1e-9 ? "fail" : "pass";
  }

  function outOfTolerance(nominalText, readingText, deviation) {
    return toleranceResult(nominalText, readingText, deviation) === "fail";
  }

  // In an inch range a plain number gets the inch mark: 1.000 -> 1.000"
  function addInchMark(reading, rangeText) {
    if (!(rangeText || "").includes('"')) return reading;
    const text = (reading || "").trim();
    return new RegExp(`^${NUMBER}$`).test(text) ? text + '"' : reading;
  }

  // Remarks starting with the word Pass or Fail -> ['pass'/'fail', the rest]; else [null, text]
  function splitLeadingResult(text) {
    const stripped = (text || "").replace(/^\s+/, "");
    for (const word of ["pass", "fail"]) {
      const after = stripped.slice(word.length, word.length + 1);
      if (stripped.toLowerCase().startsWith(word) && !/^\p{L}$/u.test(after)) return [word, stripped.slice(word.length)];
    }
    return [null, text || ""];
  }

  // The remarks after ticking Pass or Fail (or un-ticking: word '')
  function remarksForResult(text, word) {
    const [lead, rest] = splitLeadingResult(text);
    if (word) {
      if (lead) return word + rest;
      return text.trim() ? `${word} - ${text.trim()}` : word;
    }
    return lead ? rest.replace(/^[ -]+/, "") : text;
  }

  // ---------- dates (ISO 'YYYY-MM-DD' strings, like the database) ----------
  function iso(d) {
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function parseIso(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
  }

  function addMonths(d, months) {
    const index = d.getMonth() + months;
    const year = d.getFullYear() + Math.floor(index / 12);
    const month = ((index % 12) + 12) % 12;
    const last = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(d.getDate(), last));
  }

  function intervalIsNever(text) {
    return (text || "").trim().toLowerCase() === "never";
  }

  // The next due date (ISO) from a start date (ISO) and the tool's
  // Calibration Interval; '' for 'Never'; unclear intervals: 3 months
  function dueFromInterval(startIso, intervalText) {
    const start = parseIso(startIso);
    if (!start) return "";
    if (intervalIsNever(intervalText)) return "";
    const text = (intervalText || "").trim().toLowerCase().replace(/\.+$/, "");
    const named = { monthly: 1, quarterly: 3, "semi-annually": 6, semiannually: 6, annually: 12, annual: 12, yearly: 12 };
    if (text in named) return iso(addMonths(start, named[text]));
    const m = /^(\d+)\s*(days?|d|weeks?|wks?|w|months?|mos?|m|years?|yrs?|y)$/.exec(text);
    if (m) {
      const n = parseInt(m[1], 10), unit = m[2][0];
      if (unit === "d" && n >= 1 && n <= 3650) return iso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + n));
      if (unit === "w" && n >= 1 && n <= 520) return iso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * n));
      if (unit === "m" && n >= 1 && n <= 120) return iso(addMonths(start, n));
      if (unit === "y" && n >= 1 && n <= 10) return iso(addMonths(start, 12 * n));
    }
    return iso(addMonths(start, 3));
  }

  function today() {
    return iso(new Date());
  }

  return { parseMeasurement, parseDeviation, toleranceResult, outOfTolerance, addInchMark, splitLeadingResult,
           remarksForResult, intervalIsNever, dueFromInterval, parseIso, today };
})();
