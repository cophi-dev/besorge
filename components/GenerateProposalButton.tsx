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

import type { ProjectMegapackConfig } from "@/components/MegapackConfigurator";
import { Button } from "@/components/ui/button";

type GenerateProposalButtonProps = {
  projectName: string;
  config?: ProjectMegapackConfig;
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
});

function sanitizeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function calculateFinancialSummary(config: ProjectMegapackConfig) {
  const dailyCycles = 1;
  const priceSpread = 85;
  const projectLifetimeYears = 20;
  const inflationRate = 2;

  const powerMw = config.totalPowerMw;
  const energyMwh = config.totalEnergyMwh;
  const efficiency = config.roundTripEfficiency / 100;

  const annualEnergyMwh = powerMw * energyMwh * efficiency * dailyCycles * 365;
  const annualArbitrageRevenue = annualEnergyMwh * priceSpread * 0.6;
  const annualPeakShavingRevenue = annualEnergyMwh * priceSpread * 0.25;
  const annualGridServicesRevenue = annualEnergyMwh * priceSpread * 0.15;
  const annualRevenue =
    annualArbitrageRevenue + annualPeakShavingRevenue + annualGridServicesRevenue;
  const capex = energyMwh * 220_000;
  const annualOperatingCosts = capex * 0.015;
  const annualNetCashflow = annualRevenue - annualOperatingCosts;

  const yearlyRevenues = Array.from({ length: projectLifetimeYears }, (_, idx) => {
    const inflationMultiplier = (1 + inflationRate / 100) ** idx;
    return annualRevenue * inflationMultiplier;
  });

  const totalRevenueOverLifetime = yearlyRevenues.reduce((sum, value) => sum + value, 0);
  const paybackYears =
    annualNetCashflow > 0 ? capex / annualNetCashflow : Number.POSITIVE_INFINITY;
  const grossIrr =
    capex > 0 && totalRevenueOverLifetime > 0
      ? ((totalRevenueOverLifetime / capex) ** (1 / projectLifetimeYears) - 1) * 100
      : 0;

  return {
    annualRevenue,
    totalRevenueOverLifetime,
    paybackYears: Number.isFinite(paybackYears) ? paybackYears : 0,
    grossIrr,
    lcoe:
      annualEnergyMwh * projectLifetimeYears > 0
        ? (capex + annualOperatingCosts * projectLifetimeYears) /
          (annualEnergyMwh * projectLifetimeYears)
        : 0,
  };
}

function ProposalDocument({
  projectName,
  config,
}: {
  projectName: string;
  config: ProjectMegapackConfig;
}) {
  const financial = calculateFinancialSummary(config);
  const layoutDescription = `The concept layout places ${config.count} ${config.label} units in ${Math.ceil(
    config.count / 4
  )} clean rows with service aisles, central inverter access, and safety clearance zones. Total estimated site footprint: ${NUMBER_FORMATTER.format(
    config.footprintM2
  )} m².`;

  return (
    <Document>
      <Page size="A4" style={proposalStyles.page}>
        <View style={proposalStyles.topAccent} />
        <Text style={proposalStyles.headerLabel}>Tesla Energy Proposal</Text>
        <Text style={proposalStyles.title}>{projectName}</Text>
        <Text style={proposalStyles.subtitle}>
          Utility-scale battery proposal generated from live BESS configurator data.
        </Text>

        <View style={proposalStyles.section}>
          <Text style={proposalStyles.sectionTitle}>Megapack Configuration</Text>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Model</Text>
            <Text style={proposalStyles.value}>{config.label}</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Units</Text>
            <Text style={proposalStyles.value}>{config.count}</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Total Power</Text>
            <Text style={proposalStyles.value}>{NUMBER_FORMATTER.format(config.totalPowerMw)} MW</Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Total Energy</Text>
            <Text style={proposalStyles.value}>{NUMBER_FORMATTER.format(config.totalEnergyMwh)} MWh</Text>
          </View>
        </View>

        <View style={proposalStyles.section}>
          <Text style={proposalStyles.sectionTitle}>Financial Summary</Text>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Annual Revenue (est.)</Text>
            <Text style={proposalStyles.value}>
              {CURRENCY_FORMATTER.format(financial.annualRevenue)}
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Lifetime Revenue (20 years)</Text>
            <Text style={proposalStyles.value}>
              {CURRENCY_FORMATTER.format(financial.totalRevenueOverLifetime)}
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>Simple Payback</Text>
            <Text style={proposalStyles.value}>
              {NUMBER_FORMATTER.format(financial.paybackYears)} years
            </Text>
          </View>
          <View style={proposalStyles.row}>
            <Text style={proposalStyles.key}>IRR (gross)</Text>
            <Text style={proposalStyles.value}>{NUMBER_FORMATTER.format(financial.grossIrr)} %</Text>
          </View>
        </View>

        <View style={proposalStyles.section}>
          <Text style={proposalStyles.sectionTitle}>Layout Visual (Description)</Text>
          <Text style={proposalStyles.description}>{layoutDescription}</Text>
        </View>

        <Text style={proposalStyles.footer}>Prepared for Tesla Energy - Confidential</Text>
      </Page>
    </Document>
  );
}

export default function GenerateProposalButton({
  projectName,
  config,
}: GenerateProposalButtonProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const trimmedProjectName = useMemo(() => projectName.trim(), [projectName]);

  const disabled = !config || trimmedProjectName.length === 0 || isGenerating;

  const handleGenerate = async () => {
    if (!config || trimmedProjectName.length === 0) {
      return;
    }

    setIsGenerating(true);

    try {
      const document = (
        <ProposalDocument projectName={trimmedProjectName} config={config} />
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
