export default function nativeSmokeExtension(pi) {
  pi.registerCommand('native-smoke-extension', {
    description: 'Proves a dynamically loaded packaged Pi Extension',
    handler: async () => {},
  })
}
