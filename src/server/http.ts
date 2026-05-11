import type { ApiEndpointKey, ApiResponse } from "../../shared/api.js"

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export function apiJson<K extends ApiEndpointKey>(
  contract: K,
  data: ApiResponse<K>,
  status = 200,
): Response {
  void contract
  return json(data, status)
}

export function apiJsonWithHeaders<K extends ApiEndpointKey>(
  contract: K,
  data: ApiResponse<K>,
  headers: HeadersInit,
  status = 200,
): Response {
  void contract
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

export function notFound(message: string): never {
  throw new ApiError(404, message)
}
