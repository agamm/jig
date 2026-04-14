export interface ConnectorBuildTimeResolution {
  server: string
  resolvedTarget?: string
  resolvedInputSchema?: unknown
}

export interface ConnectorBuildTimePolicyIssue {
  message: string
}

export interface ConnectorBuildTimeValidationInput {
  code: string
  resolution: ConnectorBuildTimeResolution
}

export type ConnectorBuildTimeValidator =
  (input: ConnectorBuildTimeValidationInput) => ConnectorBuildTimePolicyIssue[]
