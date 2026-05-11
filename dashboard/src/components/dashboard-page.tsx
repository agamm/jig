"use client";

import { DashboardShell } from "@/components/dashboard-shell";
import { useJigListLiveUpdates } from "@/hooks/use-jig-list-live-updates";
import { useExamples, useHealth, useJigs } from "@/lib/swr";

export function DashboardPage() {
  useJigListLiveUpdates();
  const { data: jigs, isLoading, error } = useJigs({
    errorRetryInterval: 1000,
    errorRetryCount: 10,
  });
  const { data: examples, error: examplesError } = useExamples();
  const { data: health } = useHealth();

  return (
    <DashboardShell
      jigs={jigs ?? []}
      examples={examples ?? []}
      loading={isLoading}
      errorMessage={error?.message}
      examplesErrorMessage={examplesError?.message}
      storageHealth={health?.data_storage}
    />
  );
}
