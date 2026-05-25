"use client";

import { useEffect, useState } from "react";

type BriefingSectionNavProps = {
  language: "en" | "de";
};

const SECTIONS = [
  { id: "briefing-live", de: "Live", en: "Live" },
  { id: "overview", de: "Profil", en: "Profile" },
  { id: "methodology", de: "Methodik", en: "Methodology" },
  { id: "fleet-map", de: "Karte", en: "Map" },
] as const;

export function BriefingSectionNav({ language }: BriefingSectionNavProps) {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    const sectionElements = SECTIONS.map((section) => document.getElementById(section.id)).filter(
      (element): element is HTMLElement => element !== null
    );
    if (sectionElements.length === 0) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]?.target.id) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: "-40% 0px -45% 0px",
        threshold: [0, 0.15, 0.35, 0.55],
      }
    );

    sectionElements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  const handleJump = (id: string) => {
    const target = document.getElementById(id);
    if (!target) {
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  };

  return (
    <nav
      className="sticky top-[calc(3.5rem+env(safe-area-inset-top,0px))] z-[1100] -mx-5 border-b border-border/50 bg-background/90 px-5 py-2 backdrop-blur-xl sm:top-[calc(4rem+env(safe-area-inset-top,0px))] sm:-mx-0 sm:rounded-xl sm:border sm:px-2 lg:top-[calc(68px+env(safe-area-inset-top,0px))]"
      aria-label={language === "de" ? "Briefing-Abschnitte" : "Briefing sections"}
    >
      <div className="flex gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map((section) => {
          const label = language === "de" ? section.de : section.en;
          const active = activeId === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => handleJump(section.id)}
              className={`min-h-9 shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold tracking-tight transition sm:px-4 sm:text-sm ${
                active
                  ? "bg-foreground text-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
              aria-current={active ? "true" : undefined}
            >
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
