import { z } from "zod";

import { createLogger } from "@/lib/debug";
import { GERMANY_BESS_PROJECTS, type GermanyBessProject } from "@/lib/germanyBessProjects";

const log = createLogger("overpass-bess");

const elementSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z
    .object({
      lat: z.number(),
      lon: z.number(),
    })
    .optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const overpassResponseSchema = z.object({
  elements: z.array(elementSchema),
});

const parseCapacity = (value?: string): { powerMw: number; energyMwh: number } => {
  if (!value) {
    return { powerMw: 0, energyMwh: 0 };
  }

  const normalized = value.toLowerCase().replace(",", ".").trim();
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(w|kw|mw|gw|wh|kwh|mwh|gwh)?/);
  if (!match) {
    return { powerMw: 0, energyMwh: 0 };
  }

  const rawValue = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(rawValue)) {
    return { powerMw: 0, energyMwh: 0 };
  }

  if (unit === "w" || unit === "mw" || unit === "kw" || unit === "gw") {
    const powerMw =
      unit === "w"
        ? rawValue / 1_000_000
        : unit === "kw"
          ? rawValue / 1_000
          : unit === "gw"
            ? rawValue * 1_000
            : rawValue;
    return { powerMw, energyMwh: 0 };
  }

  if (unit === "wh" || unit === "mwh" || unit === "kwh" || unit === "gwh") {
    const energyMwh =
      unit === "wh"
        ? rawValue / 1_000_000
        : unit === "kwh"
          ? rawValue / 1_000
          : unit === "gwh"
            ? rawValue * 1_000
            : rawValue;
    return { powerMw: 0, energyMwh };
  }

  return { powerMw: 0, energyMwh: 0 };
};

const toProject = (element: z.infer<typeof elementSchema>, index: number): GermanyBessProject | null => {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (lat === undefined || lng === undefined) {
    return null;
  }

  const tags = element.tags ?? {};
  const powerCandidates = [
    tags["output:electricity"],
    tags["generator:output:electricity"],
    tags["plant:output:electricity"],
    tags["capacity:power"],
    tags["rating"],
    tags["power"],
  ];
  const energyCandidates = [
    tags["storage_capacity"],
    tags["capacity:energy"],
    tags["capacity"],
    tags["battery:capacity"],
  ];
  const power = powerCandidates
    .map((candidate) => parseCapacity(candidate))
    .find((parsed) => parsed.powerMw > 0) ?? { powerMw: 0, energyMwh: 0 };
  const energy = energyCandidates
    .map((candidate) => parseCapacity(candidate))
    .find((parsed) => parsed.energyMwh > 0) ?? { powerMw: 0, energyMwh: 0 };
  const inferredEnergyMwh = energy.energyMwh > 0 ? energy.energyMwh : power.powerMw > 0 ? power.powerMw * 2 : 0;
  const energySource: GermanyBessProject["energySource"] =
    energy.energyMwh > 0 ? "reported" : "estimated";
  const statusTag = (tags["operational_status"] ?? tags["construction"] ?? "").toLowerCase();
  const status: GermanyBessProject["status"] = statusTag.includes("construct")
    ? "construction"
    : statusTag.includes("plan")
      ? "announced"
      : "operational";

  return {
    id: `osm-${element.type}-${index}`,
    name: tags["name"] ?? "Battery storage site",
    operator: tags["operator"] ?? "Unknown operator",
    city: tags["addr:city"] ?? tags["name:de"] ?? "Germany",
    lat,
    lng,
    powerMw: power.powerMw,
    energyMwh: inferredEnergyMwh,
    energySource,
    status,
  };
};

export const getGermanyBessProjects = async (): Promise<{
  source: "overpass" | "fallback";
  projects: GermanyBessProject[];
  fallbackReason?: string;
}> => {
  const query = `
[out:json][timeout:30];
area["ISO3166-1"="DE"][admin_level=2]->.searchArea;
(
  nwr["power"="battery"](area.searchArea);
  nwr["power"="storage"]["storage"="battery"](area.searchArea);
  nwr["storage"="battery"](area.searchArea);
  nwr["plant:source"="battery"](area.searchArea);
  nwr["generator:source"="battery"](area.searchArea);
  nwr["generator:method"="battery_storage"](area.searchArea);
);
out center tags 3000;
`;

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  try {
    let lastError = "unknown";
    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12_000);
      try {
        const url = `${endpoint}?${new URLSearchParams({ data: query }).toString()}`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": "speicherpilot/1.0",
          },
          signal: controller.signal,
          next: { revalidate: 60 * 60 * 12 },
        });

        if (!response.ok) {
          lastError = `${endpoint} returned ${response.status}`;
          continue;
        }

        const payload = await response.json();
        const parsed = overpassResponseSchema.safeParse(payload);
        if (!parsed.success) {
          lastError = `${endpoint} returned invalid JSON shape`;
          continue;
        }

        const projects = parsed.data.elements
          .map((element, index) => toProject(element, index))
          .filter((project): project is GermanyBessProject => project !== null);

        if (projects.length > 0) {
          return { source: "overpass", projects };
        }
        lastError = `${endpoint} returned 0 matched battery features`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "request failed";
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new Error(lastError);
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : "unknown failure";
    log("overpass failed, returning fallback list %o", { fallbackReason });
    return { source: "fallback", projects: GERMANY_BESS_PROJECTS, fallbackReason };
  }
};
