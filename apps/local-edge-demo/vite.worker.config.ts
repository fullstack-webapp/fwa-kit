import { createFwaViteIntegration } from '@fullstack-webapp/local-edge/vite'

const localEdge = createFwaViteIntegration(
  new URL('./fwa.config.json', import.meta.url),
)

export default localEdge.workerConfig()
