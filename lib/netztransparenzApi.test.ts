import { __NETZTRANSPARENZ_TESTING__ } from "@/lib/netztransparenzApi";

describe("netztransparenzApi.parseDesignatedCurtailmentCsv", () => {
  const { parseDesignatedCurtailmentCsv } = __NETZTRANSPARENZ_TESTING__;

  it("parses the live ausgewieseneABSM CSV layout with relief-region columns", () => {
    const csv = [
      "Datum;Zeitzone;von;bis;Datenkategorie;Einheit;H1;H2;T1;T2;T3;T4;T5;T6",
      "10.05.2026;UTC;00:00;00:15;ausgewiesene Abregelungsstrommenge;MW;1,000;2,000;3,000;4,000;5,000;6,000;7,000;8,000",
    ].join("\n");

    const parsed = parseDesignatedCurtailmentCsv(csv);

    expect(parsed.get("2026-05-10T00:00:00.000Z")).toBeCloseTo(36, 6);
  });

  it("parses quarter-hour MW rows and sums regional columns when no Germany aggregate exists", () => {
    const csv = [
      "Datum;von;Zeitzone von;bis;Zeitzone bis;Region A (MW);Region B (MW)",
      "2026-05-09;00:00;UTC;00:15;UTC;12,5;7,5",
      "2026-05-09;00:15;UTC;00:30;UTC;1,0;2,0",
    ].join("\n");

    const parsed = parseDesignatedCurtailmentCsv(csv);

    expect(parsed.get("2026-05-09T00:00:00.000Z")).toBeCloseTo(20, 6);
    expect(parsed.get("2026-05-09T00:15:00.000Z")).toBeCloseTo(3, 6);
  });

  it("prefers the Germany aggregate column over summing detailed columns", () => {
    const csv = [
      "Datum;von;Zeitzone von;bis;Zeitzone bis;Deutschland;Region A (MW);Region B (MW)",
      "2026-05-09;00:00;UTC;00:15;UTC;20,0;12,5;7,5",
    ].join("\n");

    const parsed = parseDesignatedCurtailmentCsv(csv);

    expect(parsed.get("2026-05-09T00:00:00.000Z")).toBeCloseTo(20, 6);
  });
});
