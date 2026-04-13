"use client";

import dynamic from "next/dynamic";

const DashboardPage = dynamic(
  () => import("@/components/dashboard-page").then((mod) => mod.DashboardPage),
  {
    ssr: false,
    loading: () => (
      <main className="flex h-full items-center justify-center bg-[#0a0a0b] text-sm text-[#555]">
        Loading dashboard...
      </main>
    ),
  },
);

export default function Page() {
  return <DashboardPage />;
}
