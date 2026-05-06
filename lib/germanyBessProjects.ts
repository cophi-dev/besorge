export type GermanyBessProject = {
  id: string;
  name: string;
  operator: string;
  city: string;
  lat: number;
  lng: number;
  powerMw: number;
  energyMwh: number;
  energySource: "reported" | "estimated";
  /** MaStR rows without coords are placed at state centroid (+ jitter). */
  coordinateQuality?: "exact" | "bundesland_approx";
  status: "operational" | "construction" | "announced";
};

// Curated, public-reference project list for map context.
export const GERMANY_BESS_PROJECTS: GermanyBessProject[] = [
  {
    id: "werne",
    name: "Werne BESS",
    operator: "RWE",
    city: "Werne",
    lat: 51.6629,
    lng: 7.6316,
    powerMw: 117,
    energyMwh: 128,
    energySource: "reported",
    coordinateQuality: "exact",
    status: "operational",
  },
  {
    id: "hamm",
    name: "Hamm BESS",
    operator: "RWE",
    city: "Hamm",
    lat: 51.6739,
    lng: 7.815,
    powerMw: 140,
    energyMwh: 151,
    energySource: "reported",
    coordinateQuality: "exact",
    status: "operational",
  },
  {
    id: "kupferzell",
    name: "Kupferzell BESS",
    operator: "EnBW",
    city: "Kupferzell",
    lat: 49.2267,
    lng: 9.6894,
    powerMw: 100,
    energyMwh: 100,
    energySource: "reported",
    coordinateQuality: "exact",
    status: "operational",
  },
  {
    id: "schwerin",
    name: "Schwerin BESS",
    operator: "WEMAG",
    city: "Schwerin",
    lat: 53.6294,
    lng: 11.4148,
    powerMw: 10,
    energyMwh: 15,
    energySource: "reported",
    coordinateQuality: "exact",
    status: "operational",
  },
  {
    id: "jarpstedt",
    name: "Jarpstedt BESS",
    operator: "EWE",
    city: "Jarpstedt",
    lat: 52.8739,
    lng: 8.5796,
    powerMw: 50,
    energyMwh: 100,
    energySource: "reported",
    coordinateQuality: "exact",
    status: "operational",
  },
];
