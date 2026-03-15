import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getHeliosDir } from "../../store/database.js";
import type { AuthCredentials, ProviderName } from "../types.js";

const AUTH_FILE = "auth.json";

interface StoredAuth {
  claude?: AuthCredentials;
  openai?: AuthCredentials;
  vllm?: AuthCredentials;
}

export class TokenStore {
  private filePath: string;
  private data: StoredAuth;

  constructor() {
    const dir = join(getHeliosDir(), "auth");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.filePath = join(dir, AUTH_FILE);
    this.data = this.load();
  }

  private load(): StoredAuth {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as StoredAuth;
    } catch {
      return {};
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get(provider: ProviderName): AuthCredentials | null {
    return this.data[provider] ?? null;
  }

  set(provider: ProviderName, creds: AuthCredentials): void {
    this.data[provider] = creds;
    this.save();
  }

  clear(provider: ProviderName): void {
    delete this.data[provider];
    this.save();
  }

  isExpired(provider: ProviderName): boolean {
    const creds = this.data[provider];
    if (!creds?.expiresAt) return false;
    return Date.now() >= creds.expiresAt;
  }

  needsRefresh(provider: ProviderName): boolean {
    const creds = this.data[provider];
    if (!creds) return true;
    if (creds.method === "api_key") return false;
    if (!creds.expiresAt) return false;
    // Refresh 5 minutes before expiry
    return Date.now() >= creds.expiresAt - 5 * 60 * 1000;
  }
}
