import { TokenStore } from "./token-store.js";
import type { AuthCredentials, AuthMethod, ProviderName } from "../types.js";

export class AuthManager {
  readonly tokenStore: TokenStore;
  private refreshPromises = new Map<string, Promise<AuthCredentials>>();
  private refreshHandlers = new Map<
    string,
    (refreshToken: string) => Promise<{
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }>
  >();

  constructor() {
    this.tokenStore = new TokenStore();
  }

  /**
   * Register a refresh handler for a provider.
   * Called automatically when tokens need refreshing.
   */
  registerRefreshHandler(
    provider: ProviderName,
    handler: (refreshToken: string) => Promise<{
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }>,
  ): void {
    this.refreshHandlers.set(provider, handler);
  }

  async getCredentials(
    provider: ProviderName,
  ): Promise<AuthCredentials | null> {
    const creds = this.tokenStore.get(provider);
    if (!creds) return null;

    // Auto-refresh OAuth tokens when needed
    if (
      creds.method === "oauth" &&
      this.tokenStore.needsRefresh(provider) &&
      creds.refreshToken
    ) {
      // Deduplicate concurrent refresh attempts per provider
      if (!this.refreshPromises.has(provider)) {
        this.refreshPromises.set(
          provider,
          this.refresh(provider, creds).finally(() => {
            this.refreshPromises.delete(provider);
          }),
        );
      }
      return this.refreshPromises.get(provider)!;
    }

    return creds;
  }

  async setApiKey(
    provider: ProviderName,
    apiKey: string,
  ): Promise<void> {
    this.tokenStore.set(provider, {
      method: "api_key",
      provider,
      apiKey,
    });
  }

  async setOAuthTokens(
    provider: ProviderName,
    accessToken: string,
    refreshToken: string,
    expiresAt: number,
  ): Promise<void> {
    this.tokenStore.set(provider, {
      method: "oauth",
      provider,
      accessToken,
      refreshToken,
      expiresAt,
    });
  }

  isAuthenticated(provider: ProviderName): boolean {
    const creds = this.tokenStore.get(provider);
    if (!creds) return false;
    if (creds.method === "api_key") return !!creds.apiKey;
    // For OAuth, consider authenticated if we have tokens
    // (even if expired, we can try to refresh)
    return !!(creds.accessToken || creds.refreshToken);
  }

  private async refresh(
    provider: ProviderName,
    creds: AuthCredentials,
  ): Promise<AuthCredentials> {
    const handler = this.refreshHandlers.get(provider);
    if (!handler || !creds.refreshToken) {
      // Can't refresh — return stale creds and let the API call fail
      return creds;
    }

    try {
      const tokens = await handler(creds.refreshToken);
      const updated: AuthCredentials = {
        method: "oauth",
        provider,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      };
      this.tokenStore.set(provider, updated);
      return updated;
    } catch {
      // Refresh failed — return stale creds
      return creds;
    }
  }
}
