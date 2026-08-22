import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      name: 'fwa-client-public-types',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'client.d.ts',
          source: readFileSync(
            new URL(
              './src/loader/client-public.d.ts',
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
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: 'src/loader/client-entry.ts',
      formats: ['es'],
      fileName: () => 'client.js',
    },
  },
})
