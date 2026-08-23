// Test script to verify simulation logic
const QUARTER_HOUR_H = 0.25;

// Simplified simulation functions (copied from optimalBessCapacity.ts)
function resolvePowerCapMwhPerSlot(maxPowerMw) {
  return maxPowerMw !== null && maxPowerMw !== undefined && Number.isFinite(maxPowerMw) && maxPowerMw > 0
    ? maxPowerMw * QUARTER_HOUR_H
    : Number.POSITIVE_INFINITY;
}

function structuralNetMwhForSlot(slot) {
  return (slot.totalGenerationMw - slot.loadMw) * QUARTER_HOUR_H;
}

function simulateAdjustedNetMwAtCapacity(slots, capacityMwh, options) {
  const cap = Math.max(0, capacityMwh);
  const powerCapMwhPerSlot = resolvePowerCapMwhPerSlot(options?.maxPowerMw);
  let socMwh = Math.min(cap, Math.max(0, options?.initialSocMwh ?? 0));
  const adjusted = [];

  for (const s of slots) {
    const netMwh = structuralNetMwhForSlot(s);
    const curtailedMwh = 0; // No curtailment data
    
    if (netMwh < 0) {
      const deficit = -netMwh;
      const discharge = Math.min(socMwh, deficit, powerCapMwhPerSlot);
      socMwh -= discharge;
      adjusted.push((-deficit + discharge) / QUARTER_HOUR_H);
    } else {
      const structuralCharge = Math.min(Math.max(0, cap - socMwh), netMwh, powerCapMwhPerSlot);
      socMwh += structuralCharge;
      adjusted.push((netMwh - structuralCharge) / QUARTER_HOUR_H);
    }
  }
  return adjusted;
}

async function main() {
  // Fetch today's data
  const response = await fetch('http://localhost:3000/api/market/de/energy-flow?day=2026-08-23');
  const data = await response.json();
  const slots = data.slots;
  
  console.log(`Loaded ${slots.length} slots`);
  
  // Test with 210 GWh capacity and 27 GW power
  const capacityMwh = 210576;
  const maxPowerMw = 26719.6;
  
  const adjustedNet = simulateAdjustedNetMwAtCapacity(slots, capacityMwh, {
    maxPowerMw,
    initialSocMwh: 0,
    resetDailyByBerlin: false,
  });
  
  // Calculate grid impact reduction
  let baselineAbsMwh = 0;
  let adjustedAbsMwh = 0;
  
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const netMw = slot.totalGenerationMw - slot.loadMw;
    baselineAbsMwh += Math.abs(netMw) * QUARTER_HOUR_H;
    adjustedAbsMwh += Math.abs(adjustedNet[i] ?? netMw) * QUARTER_HOUR_H;
  }
  
  const gridImpactReductionPct = baselineAbsMwh > 0
    ? Math.min(100, Math.max(0, (1 - adjustedAbsMwh / baselineAbsMwh) * 100))
    : null;
  
  console.log('');
  console.log('=== Simulation Results ===');
  console.log(`Capacity: ${capacityMwh} MWh (${capacityMwh/1000} GWh)`);
  console.log(`Max Power: ${maxPowerMw} MW`);
  console.log(`Baseline Absolute Energy: ${baselineAbsMwh.toFixed(2)} MWh`);
  console.log(`Adjusted Absolute Energy: ${adjustedAbsMwh.toFixed(2)} MWh`);
  console.log(`Grid Impact Reduction: ${gridImpactReductionPct?.toFixed(2)}%`);
  
  // Show first few slots for debugging
  console.log('');
  console.log('=== First 5 Slots ===');
  for (let i = 0; i < 5; i++) {
    const slot = slots[i];
    const netMw = slot.totalGenerationMw - slot.loadMw;
    console.log(`Slot ${i}: original net=${netMw.toFixed(1)} MW, adjusted net=${adjustedNet[i].toFixed(1)} MW`);
  }
}

main().catch(console.error);
