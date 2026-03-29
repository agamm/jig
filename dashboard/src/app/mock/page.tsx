"use client";

import { Suspense, useState } from "react";
import type { Phase, Jig } from "@/types/jig";
import { CHAT_MESSAGES, JIGS_WEEK2, JIGS_MONTH3 } from "@/mock/mock-data";
import { DashboardShell } from "@/components/dashboard-shell";

function MockDashboard() {
  const [jigs, setJigs] = useState<Jig[]>(JIGS_WEEK2);

  function handlePhaseChange(phase: Phase) {
    setJigs(phase === "week2" ? JIGS_WEEK2 : phase === "month3" ? JIGS_MONTH3 : []);
  }

  return (
    <DashboardShell
      jigs={jigs}
      chatMessages={CHAT_MESSAGES}
      phaseToggle
      onPhaseChange={handlePhaseChange}
    />
  );
}

export default function MockPage() {
  return <Suspense><MockDashboard /></Suspense>;
}
