import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createFwaViteIntegration } from '@fullstack-webapp/local-edge/vite'

const localEdge = createFwaViteIntegration(
  new URL('./fwa.config.json', import.meta.url),
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localEdge.appPlugin()],
})
