import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the on-screen "issue" / route-status indicator. The dashboard is a polished
  // demo surface and the dev chrome reads as visual noise — Next.js will still surface
  // build/runtime errors in the terminal and React error overlay.
  devIndicators: false,
};

export default nextConfig;
