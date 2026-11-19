import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the app talks to the demo server (agent: `npm run app`, port 8080).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080', '/rpc': 'http://localhost:8080' } },
});
