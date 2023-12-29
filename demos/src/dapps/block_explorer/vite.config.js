import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'
import polyfillNode from 'rollup-plugin-polyfill-node'
import vitePluginRequire from 'vite-plugin-require'

export default defineConfig({
  plugins: [sveltekit(), vitePluginRequire.default()],
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}']
  },
  define: {
    'process.env': {}
	  },
	  optimizeDeps: {
    esbuildOptions: {

      define: {
			  global: 'globalThis'
      },
      plugins: [
        NodeGlobalsPolyfillPlugin({
          process: true,
          buffer: true
        })
      ]
    }
  },
  build: {
    rollupOptions: {
      plugins: [
        polyfillNode()
      ]
    }
	  },
  resolve: {
    alias: {
      events: 'events',
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      http: 'stream-http',
      https: 'https-browserify',
      ws: 'xrpl/dist/npm/client/WSWrapper'
    }
  }
})
