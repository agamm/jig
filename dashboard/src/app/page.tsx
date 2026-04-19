"use client";

import dynamic from "next/dynamic";
import { LoadingState } from "@/components/state-panel";
import { UnlockGate } from "@/components/unlock-gate";

const DashboardPage = dynamic(
  () => import("@/components/dashboard-page").then((mod) => mod.DashboardPage),
  {
    ssr: false,
    loading: () => (
      <main className="flex h-full items-center justify-center bg-[#0a0a0b] px-4">
        <LoadingState message="Loading dashboard…" className="w-full max-w-md" lightFrame />
      </main>
    ),
  },
);

export default function Page() {
  return (
    <UnlockGate>
      <DashboardPage />
    </UnlockGate>
  );
}
