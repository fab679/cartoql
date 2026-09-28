import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // eslint knows best here; the tuple's plugin types resolve at runtime and
  // the plugin array satisfies PluginOption modulo tsconfig bundler variance
  plugins: [react(), tailwindcss()] as never,
  server: {
    port: 5199,
    // the field console talks to the gateway; dev runs there, API calls proxy
    proxy: {
      '/graphql': 'http://localhost:4137',
      '/explain': 'http://localhost:4137',
      '/health': 'http://localhost:4137',
      '/sdl': 'http://localhost:4137',
      '/metrics': 'http://localhost:4137',
    },
  },
})
