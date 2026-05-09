const berlinDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const berlinWeekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  weekday: "short",
});

const berlinHourMinuteFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Berlin local calendar date (YYYY-MM-DD) for a UTC `Date`. */
export function formatBerlinDateKeyFromUtcDate(date: Date): string {
  return berlinDateFormatter.format(date);
}

/** Berlin local calendar date for unix seconds (UTC epoch). */
export function getBerlinDateKeyFromUnixSeconds(timestampSeconds: number): string {
  return berlinDateFormatter.format(new Date(timestampSeconds * 1000));
}

/** ISO weekday 1=Mon … 7=Sun in Europe/Berlin for a calendar `YYYY-MM-DD`. */
export function getBerlinIsoWeekdayForDateKey(dateKey: string): number {
  const noonSec = findFirstUnixSecondForBerlinDateKey(dateKey) + 12 * 3600;
  const wd = berlinWeekdayFormatter.format(new Date(noonSec * 1000));
  return WEEKDAY_TO_ISO[wd] ?? 1;
}

/**
 * Smallest unix second `s` such that the Berlin calendar date at `s` equals `dateKey`
 * (start of that Berlin day).
 */
export function findFirstUnixSecondForBerlinDateKey(dateKey: string): number {
  const parts = dateKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid Berlin date key: ${dateKey}`);
  }
  const [y, mo, da] = parts;
  let lo = Math.floor(Date.UTC(y, mo - 1, da - 2) / 1000);
  let hi = Math.floor(Date.UTC(y, mo - 1, da + 2) / 1000);
  let result = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const key = getBerlinDateKeyFromUnixSeconds(mid);
    if (key >= dateKey) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (getBerlinDateKeyFromUnixSeconds(result) !== dateKey) {
    throw new Error(`Could not resolve Berlin midnight for ${dateKey}`);
  }
  return result;
}

/** Next Berlin calendar date after `dateKey` (handles DST). */
export function nextBerlinDateKey(dateKey: string): string {
  const s0 = findFirstUnixSecondForBerlinDateKey(dateKey);
  let lo = s0 + 1;
  let hi = s0 + 3 * 86_400;
  let result = getBerlinDateKeyFromUnixSeconds(hi);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const key = getBerlinDateKeyFromUnixSeconds(mid);
    if (key > dateKey) {
      result = key;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}

/** Previous Berlin calendar date before `dateKey`. */
export function prevBerlinDateKey(dateKey: string): string {
  const s0 = findFirstUnixSecondForBerlinDateKey(dateKey);
  let lo = s0 - 3 * 86_400;
  let hi = s0 - 1;
  let result = getBerlinDateKeyFromUnixSeconds(lo);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const key = getBerlinDateKeyFromUnixSeconds(mid);
    if (key < dateKey) {
      result = key;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export function addBerlinCalendarDays(dateKey: string, deltaDays: number): string {
  if (deltaDays === 0) {
    return dateKey;
  }
  const sign = deltaDays > 0 ? 1 : -1;
  let current = dateKey;
  for (let i = 0; i < Math.abs(deltaDays); i += 1) {
    current = sign > 0 ? nextBerlinDateKey(current) : prevBerlinDateKey(current);
  }
  return current;
}

/** Monday (ISO) of the Berlin week that contains `dateKey`. */
export function mondayBerlinIsoWeekContaining(dateKey: string): string {
  const isoDow = getBerlinIsoWeekdayForDateKey(dateKey);
  const daysFromMonday = isoDow === 1 ? 0 : isoDow === 7 ? 6 : isoDow - 1;
  return addBerlinCalendarDays(dateKey, -daysFromMonday);
}

/** Number of Berlin quarter-hours from local midnight through the current slot (1..96). */
export function berlinElapsedQuarterHoursInDayFromNow(now: Date): number {
  const parts = berlinHourMinuteFormatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return Math.min(96, hour * 4 + Math.floor(minute / 15) + 1);
}

/** Count calendar days from `startKey` through `endKey` inclusive (string order). */
export function countBerlinCalendarDaysInclusive(startKey: string, endKey: string): number {
  let n = 0;
  let d = startKey;
  while (d <= endKey) {
    n += 1;
    if (d === endKey) {
      break;
    }
    d = nextBerlinDateKey(d);
  }
  return n;
}
