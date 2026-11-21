import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: process.env.SKYSCRAPE_API_PROXY ?? 'http://127.0.0.1:3000' },
    },
  },
})
