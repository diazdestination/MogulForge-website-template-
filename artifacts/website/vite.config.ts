import fs from 'fs';
import path from 'path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

/**
 * Mirror the production static host's per-route rewrites in `vite preview`:
 * a prerendered route requested without a trailing slash (e.g. /storm-check)
 * must serve that route's dist/public/<route>/index.html, not fall through
 * to the SPA fallback (homepage). Production gets this via explicit
 * rewrites in .replit-artifact/artifact.toml (verified by verify-seo.mjs);
 * this keeps local preview — and the smoke check — behaving the same way.
 */
function prerenderTrailingSlash(base: string): Plugin {
  const outDir = path.resolve(import.meta.dirname, 'dist/public');
  return {
    name: 'prerender-trailing-slash',
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = (req.url ?? '/').split('?')[0];
        // Strip the base prefix ("/" or "/site/") to get the route path.
        const rel = base === '/' ? pathname : pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : null;
        if (
          rel &&
          rel !== '/' &&
          !rel.endsWith('/') &&
          !path.basename(rel).includes('.') &&
          fs.existsSync(path.join(outDir, rel.slice(1), 'index.html'))
        ) {
          req.url = `${pathname}/${(req.url ?? '').slice(pathname.length)}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    prerenderTrailingSlash(basePath),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
