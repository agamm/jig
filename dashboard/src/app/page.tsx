"use client";

import { Suspense, useState, useEffect } from "react";
import type { Jig, ChatMsg } from "@/types/jig";
import { DashboardShell } from "@/components/dashboard-shell";

function Dashboard() {
  const [jigs, setJigs] = useState<Jig[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/jigs");
        if (res.ok) setJigs(await res.json());
      } catch (e) {
        console.error("Failed to fetch jigs:", e);
      }
      const { CHAT_MESSAGES } = await import("@/mock/mock-data");
      setChatMessages(CHAT_MESSAGES);
      setLoading(false);
    }
    load();
  }, []);

  return <DashboardShell jigs={jigs} chatMessages={chatMessages} loading={loading} />;
}

export default function Page() {
  return <Suspense><Dashboard /></Suspense>;
}
