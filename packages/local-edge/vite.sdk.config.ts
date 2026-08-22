import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      name: 'fwa-sdk-public-types',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'vite.d.ts',
          source: readFileSync(
            new URL(
              './src/build/vite-public.d.ts',
              import.meta.url,
            ),
            'utf8',
          ),
        })
      },
    },
  ],
  publicDir: false,
  build: {
    outDir: 'dist-sdk',
    emptyOutDir: true,
    minify: false,
    ssr: 'src/build/vite-integration.ts',
    rollupOptions: {
      external: ['node:fs', 'node:url', 'vite'],
      output: {
        entryFileNames: 'vite.js',
      },
    },
  },
})
