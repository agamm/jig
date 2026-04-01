"use client";

import { Suspense } from "react";
import { DashboardShell } from "@/components/dashboard-shell";
import { useJigs } from "@/lib/swr";

function Dashboard() {
  const { data: jigs, isLoading } = useJigs({
    // Backend may still be starting — retry aggressively on error
    errorRetryInterval: 1000,
    errorRetryCount: 10,
  });

  return <DashboardShell jigs={jigs ?? []} loading={isLoading} />;
}

export default function Page() {
  return <Suspense><Dashboard /></Suspense>;
}
