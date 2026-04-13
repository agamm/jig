"use client";

import { useMemo } from "react";
import type { Connection } from "@shared/api";

export function useConnectionCatalog(connections: Connection[] | undefined) {
  return useMemo(() => {
    const availableConnections = connections ?? [];
    const connectedCount = availableConnections.filter((connection) => connection.connected).length;
    const firstDisconnectedConnection =
      availableConnections.find((connection) => !connection.connected) ?? null;

    return {
      availableConnections,
      connectedCount,
      firstDisconnectedConnection,
    };
  }, [connections]);
}
