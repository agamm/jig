"use client";

import { useEffect } from "react";
import { mutate } from "swr";

export function useJigListLiveUpdates() {
  useEffect(() => {
    const source = new EventSource("/api/events");
    const handleJigsUpdated = () => {
      void mutate("jigs");
    };

    source.addEventListener("jigs", handleJigsUpdated);

    return () => {
      source.removeEventListener("jigs", handleJigsUpdated);
      source.close();
    };
  }, []);
}
