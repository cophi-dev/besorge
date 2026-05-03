"use client";

import { useMemo, useState } from "react";
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  pdf,
} from "@react-pdf/renderer";
import { FileDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  computeEconomics,
  regulatoryScenarioDescription,
  type EconomicsAssumptions,
  type ProjectMegapackConfig,
} from "@/lib/bessEconomics";
import { type SitePlacement, getFinancePhysicalConfig, useProjectStore } from "@/lib/projectStore";

type GenerateProposalButtonProps = {
  projectName: string;
};

const CURRENCY_FORMATTER = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const NUMBER_FORMATTER = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
});

const proposalStyles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 52,
    paddingHorizontal: 44,
    fontFamily: "Helvetica",
    backgroundColor: "#0A0A0C",
    color: "#E5E7EB",
  },
  topAccent: {
    height: 6,
    backgroundColor: "#E31937",
    marginBottom: 28,
  },
  headerLabel: {
    fontSize: 10,
    letterSpacing: 1.4,
    color: "#F87171",
    marginBottom: 8,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: "#FFFFFF",
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 11,
    color: "#9CA3AF",
    marginBottom: 20,
  },
  section: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: "#27272A",
    borderRadius: 10,
    padding: 14,
    backgroundColor: "#111115",
  },
  sectionTitle: {
    fontSize: 11,
    letterSpacing: 1,
    color: "#FCA5A5",
    textTransform: "uppercase",
    marginBottom: 10,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },
  key: {
    fontSize: 10,
    color: "#9CA3AF",
  },
  value: {
    fontSize: 10,
    color: "#F9FAFB",
    fontWeight: 600,
  },
  description: {
    fontSize: 10,
    color: "#D1D5DB",
    lineHeight: 1.5,
  },
  footer: {
    marginTop: 24,
    borderTopWidth: 1,
    borderTopColor: "#27272A",
    paddingTop: 10,
    fontSize: 9,
    color: "#F87171",
    textAlign: "right",
  },
  bullet: {
    fontSize: 9,
    color: "#9CA3AF",
    marginBottom: 4,
  },
});

function sanitizeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function ProposalDocument({
  projectName,
  physical,
  assumptions,
  selectedConfigurations,
  sitePlacements,
}: {
  projectName: string;
  physical: ProjectMegapackConfig;
  assumptions: EconomicsAssumptions;
  selectedConfigurations: ProjectMegapackConfig[];
  sitePlacements: SitePlacement[];
}) {
  const financial = computeEconomics(physical, assumptions);
  const layoutDescription = `The concept layout places ${physical.count} ${physical.label} units in ${Math.ceil(
    physical.count / 4
  )} clean rows with service aisles, central inverter access, and safety clearance zones. Total estimated site footprint: ${NUMBER_FORMATTER.format(
    physical.footprintM2
  )} m².`;

  return (
    <Document>
      <Page size="A4" style={proposalStyles.page}>
        <View style={proposalStyles.topAccent} />
        <Text style={proposalStyles.headerLabel}>Tesla Energy Proposal</Text>
        <Text style={proposalStyles.title}>{projectName}</Text>
        <Text style={proposalStyles.subtitle}>
          Pre-sales technical sizing and indicative economics (aligned with live dashboard inputs).
        </Text>

        <View style={proposalStyles.section}>
          <Text style={proposalStyles.sectionTitle}>Megapack configuration</Text>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Model / stack</Text>
            <Text style={proposalStyles.value}>{physical.label}</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Units</Text>
            <Text style={proposalStyles.value}>{physical.count}</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Total power</Text>
            <Text style={proposalStyles.value}>{NUMBER_FORMATTER.format(physical.totalPowerMw)} MW</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Total energy</Text>
            <Text style={proposalStyles.value}>{NUMBER_FORMATTER.format(physical.totalEnergyMwh)} MWh</Text>
          </View>
        </View>

        <View style={proposalStyles.section}>
          <Text style={proposalStyles.sectionTitle}>Assumptions & exclusions</Text>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Full-cycle equivalents / day</Text>
            <Text style={proposalStyles.value}>
              {NUMBER_FORMATTER.format(assumptions.fullCycleEquivalentsPerDay)}
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Avg. spread (EUR/MWh)</Text>
            <Text style={proposalStyles.value}>
              {NUMBER_FORMATTER.format(assumptions.averagePriceSpreadEurPerMwh)}
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Project lifetime (yrs)</Text>
            <Text style={proposalStyles.value}>{assumptions.projectLifetimeYears}</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Revenue inflation (%/yr)</Text>
            <Text style={proposalStyles.value}>
              {NUMBER_FORMATTER.format(assumptions.electricityPriceInflationPercent)}
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Regulatory scenario</Text>
            <Text style={proposalStyles.value}>
              {regulatoryScenarioDescription(assumptions.gridRegulatoryScenario)}
            </Text>
          </View>
          <Text style={[proposalStyles.description, { marginTop: 10 }]}>
            Exclusions: interconnection studies, permitting, exact tariff stacking, warranty
            carve-outs, and detailed EPC scope are not represented. Figures are non-binding
            illustrations for customer alignment.
          </Text>
        </View>

        <View style={proposalStyles.section}>
          <Text style={proposalStyles.sectionTitle}>Financial summary (matches dashboard)</Text>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Annual discharged energy (est.)</Text>
            <Text style={proposalStyles.value}>
              {NUMBER_FORMATTER.format(financial.annualDischargedMwh)} MWh
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Annual revenue (est.)</Text>
            <Text style={proposalStyles.value}>
              {CURRENCY_FORMATTER.format(financial.annualRevenue)}
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>
              Lifetime revenue ({assumptions.projectLifetimeYears} yrs)
            </Text>
            <Text style={proposalStyles.value}>
              {CURRENCY_FORMATTER.format(financial.totalRevenueOverLifetime)}
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Simple payback</Text>
            <Text style={proposalStyles.value}>
              {NUMBER_FORMATTER.format(financial.paybackYears)} years
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>IRR (gross)</Text>
            <Text style={proposalStyles.value}>{NUMBER_FORMATTER.format(financial.grossIrr)} %</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>LCOE</Text>
            <Text style={proposalStyles.value}>
              {NUMBER_FORMATTER.format(financial.lcoeEurPerMwh)} EUR/MWh
            </Text>
          </View>
        </View>

        <View style={proposalStyles.section}>
          <Text style={proposalStyles.sectionTitle}>Site / preliminary layout</Text>
          <Text style={proposalStyles.description}>{layoutDescription}</Text>
          {sitePlacements.length > 0 ? (
            <Text style={[proposalStyles.description, { marginTop: 8 }]}>
              {`Map markers recorded: ${sitePlacements.length} placement(s). Example coordinate: ${sitePlacements[0]!.lat.toFixed(4)}, ${sitePlacements[0]!.lng.toFixed(4)} (WGS84).`}
            </Text>
          ) : (
            <Text style={[proposalStyles.description, { marginTop: 8 }]}>
              No map markers captured yet — add placements in the Hamburg/DE map view to enrich
              the site narrative.
            </Text>
          )}
        </View>

        {financial.assumptionFootnotes.map((line) => (
          <Text key={line} style={proposalStyles.bullet}>
            • {line}
          </Text>
        ))}

        <Text style={proposalStyles.footer}>Prepared for Tesla Energy — confidential</Text>
      </Page>

      {selectedConfigurations.length > 1 || sitePlacements.length > 0 ? (
        <Page size="A4" style={proposalStyles.page}>
          <View style={proposalStyles.topAccent} />
          <Text style={proposalStyles.headerLabel}>Appendix</Text>
          <Text style={proposalStyles.title}>Supporting detail</Text>
          <Text style={proposalStyles.subtitle}>
            Multi-block stacks and/or map placements captured in the workspace.
          </Text>

          {selectedConfigurations.length > 1 ? (
            <>
              <Text style={[proposalStyles.subtitle, { marginBottom: 12 }]}>
                Project blocks (Add to Project)
              </Text>
              {selectedConfigurations.map((block, index) => (
                <View key={`${block.label}-${index}`} style={proposalStyles.section}>
                  <Text style={proposalStyles.sectionTitle}>Block {index + 1}</Text>
                  <View style={proposalStyles.row}>
                    <Text style={proposalStyles.key}>Model</Text>
                    <Text style={proposalStyles.value}>{block.label}</Text>
                  </View>
                  <View style={proposalStyles.row}>
                    <Text style={proposalStyles.key}>Units</Text>
                    <Text style={proposalStyles.value}>{block.count}</Text>
                  </View>
                  <View style={proposalStyles.row}>
                    <Text style={proposalStyles.key}>Power / Energy</Text>
                    <Text style={proposalStyles.value}>
                      {NUMBER_FORMATTER.format(block.totalPowerMw)} MW /{" "}
                      {NUMBER_FORMATTER.format(block.totalEnergyMwh)} MWh
                    </Text>
                  </View>
                </View>
              ))}
            </>
          ) : null}

          {sitePlacements.length > 0 ? (
            <View style={[proposalStyles.section, { marginTop: 12 }]}>
              <Text style={proposalStyles.sectionTitle}>Map placements (WGS84)</Text>
              {sitePlacements.map((placement, index) => (
                <View key={placement.id} style={proposalStyles.row}>
                  <Text style={proposalStyles.key}>#{index + 1}</Text>
                  <Text style={proposalStyles.value}>
                    {placement.lat.toFixed(4)}, {placement.lng.toFixed(4)} —{" "}
                    {placement.capacityMwh.toFixed(1)} MWh
                    {placement.linkedLabel ? ` (${placement.linkedLabel})` : ""}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <Text style={proposalStyles.footer}>Prepared for Tesla Energy — confidential</Text>
        </Page>
      ) : null}
    </Document>
  );
}

export default function GenerateProposalButton({ projectName }: GenerateProposalButtonProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const trimmedProjectName = useMemo(() => projectName.trim(), [projectName]);

  const liveConfiguration = useProjectStore((state) => state.liveConfiguration);
  const selectedConfigurations = useProjectStore((state) => state.selectedConfigurations);
  const economicsAssumptions = useProjectStore((state) => state.economicsAssumptions);
  const sitePlacements = useProjectStore((state) => state.sitePlacements);

  const physical = useMemo(
    () =>
      getFinancePhysicalConfig({
        selectedConfigurations,
        liveConfiguration,
      }),
    [liveConfiguration, selectedConfigurations]
  );

  const disabled = !physical || trimmedProjectName.length === 0 || isGenerating;

  const handleGenerate = async () => {
    if (!physical || trimmedProjectName.length === 0) {
      return;
    }

    setIsGenerating(true);

    try {
      const document = (
        <ProposalDocument
          projectName={trimmedProjectName}
          physical={physical}
          assumptions={economicsAssumptions}
          selectedConfigurations={selectedConfigurations}
          sitePlacements={sitePlacements}
        />
      );
      const blob = await pdf(document).toBlob();
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      const filename = sanitizeFilename(trimmedProjectName) || "tesla-proposal";
      link.href = url;
      link.download = `${filename}-proposal.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Button
      disabled={disabled}
      onClick={handleGenerate}
      className="h-10 rounded-full bg-[#E31937] px-5 font-semibold text-white hover:bg-[#f02445] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <FileDown className="mr-2 h-4 w-4" />
      {isGenerating ? "Generating..." : "Generate Proposal"}
    </Button>
  );
}
