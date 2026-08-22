import { createFwaViteIntegration } from '@fullstack-webapp/local-edge/vite'

const localEdge = createFwaViteIntegration(
  new URL('./e2e/scoped-fwa.config.json', import.meta.url),
)

export default localEdge.workerConfig()
