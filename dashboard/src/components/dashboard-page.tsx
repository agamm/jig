"use client";

import { DashboardShell } from "@/components/dashboard-shell";
import { useExamples, useJigs } from "@/lib/swr";

export function DashboardPage() {
  const { data: jigs, isLoading } = useJigs({
    errorRetryInterval: 1000,
    errorRetryCount: 10,
  });
  const { data: examples } = useExamples();

  return <DashboardShell jigs={jigs ?? []} examples={examples ?? []} loading={isLoading} />;
}
