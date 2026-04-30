"use client";

import Link from "next/link";
import { motion } from "framer-motion";

type SiteShellProps = {
  children: React.ReactNode;
};

export function SiteShell({ children }: SiteShellProps) {
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <motion.header
        initial={{ y: -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="sticky top-0 z-40 border-b border-white/10 bg-black/45 backdrop-blur-xl"
      >
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-4 lg:px-10">
          <Link href="/" className="group flex items-center gap-3">
            <span className="tesla-glow h-2.5 w-2.5 rounded-full bg-[#E31937]" />
            <span className="text-base font-semibold tracking-[0.18em] text-white">
              BESSForge
            </span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-[#A1A1AA] sm:inline">Tesla Energy</span>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-white transition hover:border-[#E31937]/50 hover:text-[#E31937]"
            >
              GitHub
            </a>
          </div>
        </nav>
      </motion.header>

      <motion.main
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.15, ease: "easeOut" }}
      >
        {children}
      </motion.main>

      <motion.footer
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.3 }}
        className="border-t border-white/10 bg-black/35"
      >
        <div className="mx-auto max-w-7xl px-6 py-6 text-center text-sm text-[#A1A1AA] lg:px-10">
          Built for Tesla BESS Project Engineers • Hamburg
        </div>
      </motion.footer>
    </div>
  );
}
