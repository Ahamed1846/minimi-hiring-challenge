import * as chrono from 'chrono-node';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function utcDate(year, month, day) {
  const date = new Date(Date.UTC(year, month, day, 12));
  return Number.isNaN(date.getTime()) ? null : date;
}

function range(start, end, phrase, kind = 'day') {
  if (!start || !end) return null;
  return { start: dateKey(start), end: dateKey(end), phrase, kind };
}

function monthDayReference(text, today) {
  const monthNames = 'january february march april may june july august september october november december';
  const months = monthNames.split(' ');
  const month = '(?:' + months.flatMap((name) => [name, name.slice(0, 3)]).join('|') + ')';
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${month})(?:\\s*,?\\s+(20\\d{2}))?\\b`, 'i');
  const monthFirst = new RegExp(`\\b(${month})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s+(20\\d{2}))?\\b`, 'i');
  const dayFirstMatch = text.match(dayFirst);
  const isDayFirst = Boolean(dayFirstMatch);
  const match = dayFirstMatch ?? text.match(monthFirst);
  if (!match) return null;

  const rawMonth = (isDayFirst ? match[2] : match[1]).toLowerCase().slice(0, 3);
  const monthIndex = months.findIndex((name) => name.slice(0, 3) === rawMonth);
  const day = Number(isDayFirst ? match[1] : match[2]);
  const givenYear = Number(match[3]) || today.getUTCFullYear();
  let resolved = utcDate(givenYear, monthIndex, day);
  if (!resolved || resolved.getUTCMonth() !== monthIndex || resolved.getUTCDate() !== day) return null;

  if (!match[3] && resolved > today) {
    resolved = utcDate(givenYear - 1, monthIndex, day);
  }
  return range(resolved, resolved, match[0]);
}

function relativeReference(text, today) {
  const normalized = text.toLowerCase();
  const lastWeekday = normalized.match(/\blast week(?:\s+on)?\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (lastWeekday) {
    const mondayThisWeek = new Date(today);
    mondayThisWeek.setUTCDate(mondayThisWeek.getUTCDate() - ((today.getUTCDay() + 6) % 7));
    const result = new Date(mondayThisWeek);
    result.setUTCDate(result.getUTCDate() - 7 + ((WEEKDAYS.indexOf(lastWeekday[1]) + 6) % 7));
    return range(result, result, lastWeekday[0]);
  }
  const dayMatch = normalized.match(/\b(last|this|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dayMatch) {
    const target = WEEKDAYS.indexOf(dayMatch[2]);
    const current = today.getUTCDay();
    let back = (current - target + 7) % 7;
    if (dayMatch[1] === 'last' && back === 0) back = 7;
    const result = new Date(today);
    result.setUTCDate(result.getUTCDate() - back);
    return range(result, result, dayMatch[0].trim());
  }

  const relativeDays = [
    { pattern: /\bday before yesterday\b/, days: 2 },
    { pattern: /\byesterday\b/, days: 1 },
    { pattern: /\btoday\b/, days: 0 },
  ];
  for (const item of relativeDays) {
    const match = normalized.match(item.pattern);
    if (match) {
      const result = new Date(today);
      result.setUTCDate(result.getUTCDate() - item.days);
      return range(result, result, match[0]);
    }
  }

  const weekMatch = normalized.match(/\b(last|this) week\b/);
  if (weekMatch) {
    const end = new Date(today);
    const weekday = (end.getUTCDay() + 6) % 7;
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - weekday);
    if (weekMatch[1] === 'last') {
      start.setUTCDate(start.getUTCDate() - 7);
      end.setTime(start.getTime());
      end.setUTCDate(end.getUTCDate() + 6);
    }
    return range(start, end, weekMatch[0], 'range');
  }

  const daysAgo = normalized.match(/\b(\d{1,2}) days? ago\b/);
  if (daysAgo) {
    const result = new Date(today);
    result.setUTCDate(result.getUTCDate() - Number(daysAgo[1]));
    return range(result, result, daysAgo[0]);
  }

  if (/\bpast 7 days\b/.test(normalized)) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 6);
    return range(start, today, 'past 7 days', 'range');
  }

  return null;
}

/** Resolve the first explicit temporal reference using the caller's local calendar date. */
export function resolveDateReference(text, localToday) {
  const today = utcDate(
    Number(localToday.slice(0, 4)),
    Number(localToday.slice(5, 7)) - 1,
    Number(localToday.slice(8, 10)),
  );
  if (!today) return null;

  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const resolved = utcDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (resolved && resolved.getUTCMonth() === Number(iso[2]) - 1 && resolved.getUTCDate() === Number(iso[3])) {
      return range(resolved, resolved, iso[0]);
    }
  }

  const absolute = monthDayReference(text, today);
  if (absolute) return absolute;

  const relative = relativeReference(text, today);
  if (relative) return relative;

  // Chrono covers less common natural-language forms while keeping date arithmetic in code.
  const parsed = chrono.parse(text, new Date(`${localToday}T12:00:00Z`), { forwardDate: false })
    .find((item) => item.start.isCertain('day'));
  if (parsed) {
    const start = parsed.start;
    const resolved = utcDate(start.get('year'), start.get('month') - 1, start.get('day'));
    const end = parsed.end?.isCertain('day')
      ? utcDate(parsed.end.get('year'), parsed.end.get('month') - 1, parsed.end.get('day'))
      : resolved;
    return range(resolved, end, parsed.text, parsed.end ? 'range' : 'day');
  }
  return null;
}

export function dateInTimezone(isoTimestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoTimestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function utcBoundaryForLocalDate(localDate, timeZone) {
  const [year, month, day] = localDate.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    const next = target - (asUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

export function nextCalendarDay(dateKeyValue) {
  const date = new Date(`${dateKeyValue}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateKey(date);
}

export function currentLocalContext(timeZone, instant = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    instant: instant.toISOString(),
  };
}
