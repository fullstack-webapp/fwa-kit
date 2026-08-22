import { createFwaViteIntegration } from '@fullstack-webapp/local-edge/vite'

const configPath = process.env.FWA_CONFIG_PATH ?? './fwa.config.json'
const localEdge = createFwaViteIntegration(
  new URL(configPath, import.meta.url),
)

export default localEdge.loaderConfig()
