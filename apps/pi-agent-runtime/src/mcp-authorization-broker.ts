export type McpAuthorizationInput = {
  actorId: string
  documentId: string
  runId: string
  serverId: string
  toolName: string
  canonicalToolId: string
  effect: 'read'
  arguments: unknown
}

export type McpAuthorizationBrokerOptions = {
  authorizeRun: (input: McpAuthorizationInput) => Promise<boolean>
  authorizeArguments?: (input: McpAuthorizationInput) => Promise<boolean>
}

export class McpAuthorizationBroker {
  constructor(private readonly options: McpAuthorizationBrokerOptions) {}

  async authorize(input: McpAuthorizationInput): Promise<boolean> {
    if (input.effect !== 'read') return false
    if (!(await this.options.authorizeRun(input))) return false
    return this.options.authorizeArguments?.(input) ?? true
  }
}
