export default function spikeExtension(pi) {
  pi.registerTool({
    name: 'spike_extension_ping',
    label: 'Spike extension ping',
    description: 'Proves that a dynamically discovered unpacked Pi Extension loaded.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'extension-pong' }], details: {} }
    },
  })
}
