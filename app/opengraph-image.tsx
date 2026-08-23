import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "SpeicherPilot — Batteriespeicher live verstehen";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 56,
          background: "linear-gradient(145deg, #070b14 0%, #0d1324 42%, #0c1220 100%)",
          color: "#f1f5f9",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 20,
              background: "linear-gradient(135deg, #34d399, #818cf8)",
              boxShadow: "0 0 40px rgba(52,211,153,0.35)",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 52, fontWeight: 700, letterSpacing: "0.08em" }}>SpeicherPilot</div>
            <div style={{ fontSize: 22, color: "#94a3b8", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              Batteriespeicher live verstehen
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 28, color: "#cbd5e1", lineHeight: 1.35, maxWidth: 900 }}>
            Germany · Energy-Charts quarter-hours · BESS signals · Fraunhofer ISE data
          </div>
          <div
            style={{
              fontSize: 18,
              color: "#64748b",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: "#34d399",
                boxShadow: "0 0 16px rgba(52,211,153,0.8)",
              }}
            />
            Live snapshot · Berlin timezone
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
