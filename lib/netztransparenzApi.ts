import { z } from "zod";

import { findFirstUnixSecondForBerlinDateKey } from "@/lib/berlinCalendar";
import { createLogger } from "@/lib/debug";

const log = createLogger("netztransparenz");

const netztransparenzConfigSchema = z.object({
  NETZTRANSPARENZ_CLIENT_ID: z.string().min(1).optional(),
  NETZTRANSPARENZ_CLIENT_SECRET: z.string().min(1).optional(),
  NETZTRANSPARENZ_API_BASE_URL: z
    .string()
    .url()
    .default("https://ds.netztransparenz.de/api/v1"),
  NETZTRANSPARENZ_TOKEN_URL: z
    .string()
    .url()
    .default("https://identity.netztransparenz.de/users/connect/token"),
});

const tokenShape = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive().optional(),
  token_type: z.string().optional(),
});

type NetztransparenzConfig = z.infer<typeof netztransparenzConfigSchema>;
type CurtailmentFetchRange = {
  startKey: string;
  endKey: string;
  period?: string;
};

let cachedToken:
  | {
      accessToken: string;
      expiresAtMs: number;
    }
  | null = null;

const CSV_META_HEADERS = new Set([
  "datum",
  "date",
  "von",
  "(uhrzeit) von",
  "uhrzeit von",
  "zeitzone",
  "zeitzone von",
  "bis",
  "zeitzone bis",
  "datenkategorie",
  "datentyp",
  "einheit",
  "status",
]);

function loadConfig(): NetztransparenzConfig {
  return netztransparenzConfigSchema.parse({
    NETZTRANSPARENZ_CLIENT_ID: process.env.NETZTRANSPARENZ_CLIENT_ID,
    NETZTRANSPARENZ_CLIENT_SECRET: process.env.NETZTRANSPARENZ_CLIENT_SECRET,
    NETZTRANSPARENZ_API_BASE_URL: process.env.NETZTRANSPARENZ_API_BASE_URL,
    NETZTRANSPARENZ_TOKEN_URL: process.env.NETZTRANSPARENZ_TOKEN_URL,
  });
}

export function hasNetztransparenzCurtailmentConfig(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.NETZTRANSPARENZ_CLIENT_ID && cfg.NETZTRANSPARENZ_CLIENT_SECRET);
}

async function getAccessToken(cfg: NetztransparenzConfig): Promise<string | null> {
  if (!cfg.NETZTRANSPARENZ_CLIENT_ID || !cfg.NETZTRANSPARENZ_CLIENT_SECRET) {
    return null;
  }
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.NETZTRANSPARENZ_CLIENT_ID,
    client_secret: cfg.NETZTRANSPARENZ_CLIENT_SECRET,
  });

  const response = await fetch(cfg.NETZTRANSPARENZ_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    const responseBody = await response.text();
    log("token request failed %o", {
      request: { url: cfg.NETZTRANSPARENZ_TOKEN_URL, method: "POST" },
      response: {
        status: response.status,
        statusText: response.statusText,
        body: responseBody.slice(0, 500),
      },
    });
    throw new Error(`Netztransparenz token request failed with status ${response.status}`);
  }

  const parsed = tokenShape.safeParse(await response.json());
  if (!parsed.success) {
    log("token response parse failed %o", {
      request: { url: cfg.NETZTRANSPARENZ_TOKEN_URL, method: "POST" },
      issues: parsed.error.flatten(),
    });
    throw new Error("Netztransparenz token response had an unexpected shape");
  }

  cachedToken = {
    accessToken: parsed.data.access_token,
    expiresAtMs: Date.now() + Math.max(300_000, (parsed.data.expires_in ?? 3600) * 1000),
  };
  return cachedToken.accessToken;
}

function endpointCandidates(cfg: NetztransparenzConfig, range: CurtailmentFetchRange): string[] {
  const base = cfg.NETZTRANSPARENZ_API_BASE_URL.replace(/\/$/, "");
  const from = encodeURIComponent(`${range.startKey}T00:00:00`);
  const to = encodeURIComponent(`${range.endKey}T23:59:59`);
  return [
    `${base}/data/ausgewieseneABSM/${from}/${to}`,
  ];
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ";" && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((value) => value.trim());
}

function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseGermanNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-" || trimmed === "n/a") {
    return null;
  }
  const normalized = trimmed
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/\s+/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDateKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const deMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!deMatch) {
    return null;
  }
  const [, dd, mm, yyyy] = deMatch;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function parseClock(raw: string): { hour: number; minute: number; second: number } | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  return { hour, minute, second };
}

function timezoneOffsetHours(raw: string): number | null {
  const normalized = raw.trim().toUpperCase();
  if (normalized === "UTC") {
    return 0;
  }
  if (normalized === "MEZ" || normalized === "CET") {
    return 1;
  }
  if (normalized === "MESZ" || normalized === "CEST") {
    return 2;
  }
  return null;
}

function rowTimestampIso(row: Record<string, string>): string | null {
  const dateKey = normalizeDateKey(row.Datum ?? row.Date ?? "");
  const fromClock = parseClock(row.von ?? row["(Uhrzeit) von"] ?? row["Uhrzeit von"] ?? "");
  if (!dateKey || !fromClock) {
    return null;
  }
  const timezoneRaw = row["Zeitzone von"] ?? row.Zeitzone ?? "ME(S)Z";
  const fixedOffset = timezoneOffsetHours(timezoneRaw);
  if (fixedOffset !== null) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Date(
      Date.UTC(year, month - 1, day, fromClock.hour - fixedOffset, fromClock.minute, fromClock.second)
    ).toISOString();
  }
  const berlinMidnightSec = findFirstUnixSecondForBerlinDateKey(dateKey);
  const slotOffsetSec = fromClock.hour * 3600 + fromClock.minute * 60 + fromClock.second;
  return new Date((berlinMidnightSec + slotOffsetSec) * 1000).toISOString();
}

function pickAggregateHeaders(headers: string[]): string[] {
  const numericHeaders = headers.filter((header) => !CSV_META_HEADERS.has(normalizeHeader(header)));
  const germanyHeader = numericHeaders.find((header) =>
    /^(deutschland|germany)(?:\s*\(.*\))?$/i.test(header.trim())
  );
  return germanyHeader ? [germanyHeader] : numericHeaders;
}

export function parseDesignatedCurtailmentCsv(csvText: string): Map<string, number> {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return new Map();
  }

  const headers = splitCsvLine(lines[0] ?? "");
  const valueHeaders = pickAggregateHeaders(headers);
  const rows = new Map<string, number>();

  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    if (values.length === 0) {
      continue;
    }
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const timestampIso = rowTimestampIso(row);
    if (!timestampIso) {
      continue;
    }
    let totalMw = 0;
    let sawValue = false;
    for (const header of valueHeaders) {
      const value = parseGermanNumber(row[header] ?? "");
      if (value === null) {
        continue;
      }
      totalMw += value;
      sawValue = true;
    }
    if (sawValue) {
      rows.set(timestampIso, totalMw);
    }
  }
  return rows;
}

export async function getDesignatedCurtailmentMwByTimestampForBerlinRange(
  range: CurtailmentFetchRange
): Promise<Map<string, number> | null> {
  const cfg = loadConfig();
  const token = await getAccessToken(cfg);
  if (!token) {
    return null;
  }

  let lastError: Error | null = null;
  for (const url of endpointCandidates(cfg, range)) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/csv, text/plain;q=0.9, */*;q=0.1",
          Authorization: `Bearer ${token}`,
        },
        next: { revalidate: 900 },
      });
      if (response.status === 404) {
        lastError = new Error(`Netztransparenz curtailment endpoint not found: ${url}`);
        continue;
      }
      if (!response.ok) {
        const responseBody = await response.text();
        log("curtailment request failed %o", {
          request: { url, method: "GET" },
          response: {
            status: response.status,
            statusText: response.statusText,
            body: responseBody.slice(0, 500),
          },
        });
        throw new Error(`Netztransparenz curtailment request failed with status ${response.status}`);
      }
      return parseDesignatedCurtailmentCsv(await response.text());
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    log("curtailment series unavailable %o", {
      range: { startKey: range.startKey, endKey: range.endKey, period: range.period },
      error: lastError.message,
    });
  }
  return null;
}

export const __NETZTRANSPARENZ_TESTING__ = {
  parseDesignatedCurtailmentCsv,
};
