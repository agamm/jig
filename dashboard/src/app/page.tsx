"use client";

import { Suspense, useState, useEffect } from "react";
import type { Jig } from "@/types/jig";
import { DashboardShell } from "@/components/dashboard-shell";

function Dashboard() {
  const [jigs, setJigs] = useState<Jig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/jigs");
        if (res.ok) setJigs(await res.json());
      } catch (e) {
        console.error("Failed to fetch jigs:", e);
      }
      setLoading(false);
    }
    load();
  }, []);

  return <DashboardShell jigs={jigs} loading={loading} />;
}

export default function Page() {
  return <Suspense><Dashboard /></Suspense>;
}
