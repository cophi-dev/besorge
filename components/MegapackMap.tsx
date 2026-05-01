"use client";

import "leaflet/dist/leaflet.css";

import { useMemo, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, Tooltip, useMapEvents } from "react-leaflet";

type MegapackPlacement = {
  id: string;
  lat: number;
  lng: number;
  capacityMwh: number;
};

const DEFAULT_CENTER: [number, number] = [53.5511, 9.9937];
const DEFAULT_ZOOM = 6;
const MEGAPACK_CAPACITY_MWH = 3.9;

const megapackIcon = L.divIcon({
  className: "megapack-marker",
  html: `
    <div style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9999px;background:rgba(227,25,55,0.95);border:2px solid rgba(255,255,255,0.9);color:#fff;font-size:16px;box-shadow:0 8px 20px rgba(0,0,0,0.35);">
      ⚡
    </div>
  `,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

function MapClickHandler({ onPlace }: { onPlace: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(event) {
      onPlace(event.latlng.lat, event.latlng.lng);
    },
  });

  return null;
}

export default function MegapackMap() {
  const [placements, setPlacements] = useState<MegapackPlacement[]>([]);

  const totalCapacityMwh = useMemo(
    () => placements.reduce((sum, placement) => sum + placement.capacityMwh, 0),
    [placements]
  );

  const handlePlaceMegapack = (lat: number, lng: number) => {
    setPlacements((previous) => [
      ...previous,
      {
        id: crypto.randomUUID(),
        lat,
        lng,
        capacityMwh: MEGAPACK_CAPACITY_MWH,
      },
    ]);
  };

  return (
    <section className="glass-card rounded-2xl border border-white/10 p-6">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.18em] text-[#E31937]">Standortplanung</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">
          Interaktive Deutschland/Hamburg Karte
        </h2>
        <p className="mt-2 text-sm text-[#A1A1AA]">
          Klick auf die Karte, um ein Megapack zu platzieren.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10">
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className="h-[460px] w-full"
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapClickHandler onPlace={handlePlaceMegapack} />
          {placements.map((placement, index) => (
            <Marker
              key={placement.id}
              icon={megapackIcon}
              position={[placement.lat, placement.lng]}
            >
              <Tooltip direction="top" offset={[0, -12]} opacity={1}>
                Megapack #{index + 1} ({placement.capacityMwh.toFixed(1)} MWh)
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
      </div>

      <div className="mt-5 grid gap-4 rounded-xl border border-white/10 bg-black/20 p-4 md:grid-cols-[1fr_auto] md:items-center">
        <div>
          <p className="text-sm text-[#A1A1AA]">Platzierte Megapacks</p>
          <p className="text-2xl font-semibold text-white">{placements.length}</p>
        </div>
        <div className="rounded-lg border border-[#E31937]/35 bg-[#E31937]/10 px-4 py-2 text-right">
          <p className="text-xs uppercase tracking-[0.14em] text-[#E31937]">Gesamtkapazitaet</p>
          <p className="text-xl font-semibold text-white">{totalCapacityMwh.toFixed(1)} MWh</p>
        </div>
      </div>

      <div className="mt-4">
        <h3 className="text-lg font-medium text-white">Megapack Liste</h3>
        {placements.length === 0 ? (
          <p className="mt-2 text-sm text-[#A1A1AA]">
            Noch keine Platzierung vorhanden. Setze den ersten Marker per Klick.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {placements.map((placement, index) => (
              <li
                key={placement.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-[#D4D4D8]"
              >
                <span>Megapack #{index + 1}</span>
                <span>
                  {placement.lat.toFixed(4)}, {placement.lng.toFixed(4)}
                </span>
                <span>{placement.capacityMwh.toFixed(1)} MWh</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
