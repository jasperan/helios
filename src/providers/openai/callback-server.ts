import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

interface CallbackResult {
  code: string;
  state: string;
}

/**
 * Local HTTP server for OAuth callback.
 * Listens on 127.0.0.1 for the redirect from the OAuth provider.
 */
export function startCallbackServer(
  expectedState: string,
  port: number,
  path: string,
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const app = new Hono();
    let server: Server | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    app.get(path, (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const error = c.req.query("error");
      const errorDescription = c.req.query("error_description");

      if (error) {
        setTimeout(cleanup, 100);
        reject(
          new Error(
            `OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`,
          ),
        );
        return c.html(
          "<html><body><h1>Authentication failed</h1><p>You can close this tab.</p></body></html>",
        );
      }

      if (!code || !state) {
        setTimeout(cleanup, 100);
        reject(new Error("Missing code or state in callback"));
        return c.html(
          "<html><body><h1>Authentication failed</h1><p>Missing parameters.</p></body></html>",
        );
      }

      if (state !== expectedState) {
        setTimeout(cleanup, 100);
        reject(new Error("State mismatch — possible CSRF attack"));
        return c.html(
          "<html><body><h1>Authentication failed</h1><p>Invalid state.</p></body></html>",
        );
      }

      setTimeout(cleanup, 100);
      resolve({ code, state });

      return c.html(
        "<html><body><h1>Authenticated!</h1><p>You can close this tab and return to Helios.</p></body></html>",
      );
    });

    server = serve({
      fetch: app.fetch,
      port,
      hostname: "localhost",
    }) as unknown as Server;

    // Timeout after 5 minutes
    timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}
