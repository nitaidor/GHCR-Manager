import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Built-in proxy middleware so that Web/Dev mode can communicate with
 * https://ghcr.io and https://github.com/login/device without browser CORS restrictions,
 * matching the native networking behavior of Electron (Desktop) and Capacitor (Android/iOS).
 */
function ociProxyPlugin(): Plugin {
  return {
    name: 'oci-registry-proxy',
    configureServer(server) {
      server.middlewares.use('/__oci_proxy', async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const targetUrl = req.headers['x-target-url'] as string | undefined;
          if (!targetUrl) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Missing x-target-url header' }));
            return;
          }

          const parsed = new URL(targetUrl);
          const allowedHosts = [
            'ghcr.io',
            'api.github.com',
            'github.com',
            'pkg-containers.githubusercontent.com',
          ];
          const isAllowed =
            allowedHosts.includes(parsed.hostname) ||
            parsed.hostname.endsWith('.blob.core.windows.net') ||
            parsed.hostname.endsWith('.githubusercontent.com') ||
            parsed.hostname.endsWith('.fastly.net');

          if (!isAllowed) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: `Host not allowed: ${parsed.hostname}` }));
            return;
          }

          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const bodyBuffer = Buffer.concat(chunks);

          const forwardHeaders: Record<string, string> = {};
          const rawForwardHeaders = req.headers['x-forward-headers'];
          if (typeof rawForwardHeaders === 'string') {
            const decoded = JSON.parse(rawForwardHeaders) as Record<string, string>;
            for (const [k, v] of Object.entries(decoded)) {
              forwardHeaders[k] = v;
            }
          }

          // Perform request manually with redirect handling so Authorization header
          // is NOT sent when ghcr.io redirects to Azure Blob Storage / CDN on blob downloads.
          let currentUrl = targetUrl;
          let currentMethod = req.method || 'GET';
          let currentBody: Buffer | undefined =
            currentMethod !== 'GET' && currentMethod !== 'HEAD' && bodyBuffer.length > 0
              ? bodyBuffer
              : undefined;
          let currentHeaders = { ...forwardHeaders };

          let upstreamRes: Response | null = null;
          for (let hops = 0; hops < 5; hops++) {
            upstreamRes = await fetch(currentUrl, {
              method: currentMethod,
              headers: currentHeaders,
              body: currentBody ? new Uint8Array(currentBody) : undefined,
              redirect: 'manual',
            });

            if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
              const loc = upstreamRes.headers.get('location');
              if (!loc) break;
              const nextUrl = new URL(loc, currentUrl).toString();
              const nextHost = new URL(nextUrl).hostname;
              const prevHost = new URL(currentUrl).hostname;
              if (nextHost !== prevHost) {
                delete currentHeaders['Authorization'];
                delete currentHeaders['authorization'];
              }
              if (upstreamRes.status === 303) {
                currentMethod = 'GET';
                currentBody = undefined;
              }
              currentUrl = nextUrl;
              continue;
            }
            break;
          }

          if (!upstreamRes) {
            res.statusCode = 502;
            res.end('No upstream response');
            return;
          }

          res.statusCode = upstreamRes.status;
          const exposedHeaders: Record<string, string> = {};
          upstreamRes.headers.forEach((val, key) => {
            exposedHeaders[key.toLowerCase()] = val;
          });
          res.setHeader('x-upstream-headers', JSON.stringify(exposedHeaders));
          res.setHeader(
            'content-type',
            upstreamRes.headers.get('content-type') || 'application/octet-stream'
          );

          const arrayBuf = await upstreamRes.arrayBuffer();
          res.end(Buffer.from(arrayBuf));
        } catch (err: unknown) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), ociProxyPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
