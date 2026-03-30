"use client";

import { Suspense, useState, useEffect } from "react";
import type { Jig } from "@/types/jig";
import { DashboardShell } from "@/components/dashboard-shell";

function Dashboard() {
  const [jigs, setJigs] = useState<Jig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const res = await fetch("/api/jigs");
          if (res.ok && !cancelled) {
            setJigs(await res.json());
            setLoading(false);
            return;
          }
        } catch {}
        // Backend may still be starting — wait and retry
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return <DashboardShell jigs={jigs} loading={loading} />;
}

export default function Page() {
  return <Suspense><Dashboard /></Suspense>;
}
