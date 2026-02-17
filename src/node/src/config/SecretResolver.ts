import * as fs from "fs";
import * as path from "path";

export interface SecretProvider {
  type: string;
  resolve(name: string): string | undefined;
}

export interface SecretProviderConfig {
  type: string;
  path?: string;
  directory?: string;
  [key: string]: any;
}

export interface SecretsConfig {
  providers: SecretProviderConfig[];
}

/**
 * Resolves secrets from environment variables.
 */
class EnvProvider implements SecretProvider {
  type = "env";

  resolve(name: string): string | undefined {
    return process.env[name];
  }
}

/**
 * Resolves secrets from a .env file at an explicit absolute path.
 * Parses key=value lines, caches in memory.
 */
class DotenvProvider implements SecretProvider {
  type = "dotenv";
  private readonly cache: Map<string, string>;

  constructor(filePath: string) {
    this.cache = new Map();
    this.loadFile(filePath);
  }

  private loadFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();

        // Strip surrounding quotes (single or double)
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (key) {
          this.cache.set(key, value);
        }
      }
      console.log(`Loaded ${this.cache.size} secret(s) from dotenv file: ${filePath}`);
    } catch (error) {
      console.warn(`Failed to read dotenv file at ${filePath}: ${error}`);
    }
  }

  resolve(name: string): string | undefined {
    return this.cache.get(name);
  }
}

/**
 * Resolves secrets by reading individual files from a directory.
 * Looks for a file named `NAME` inside the configured directory.
 */
class FileProvider implements SecretProvider {
  type = "file";
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  resolve(name: string): string | undefined {
    // Prevent path traversal
    const safeName = path.basename(name);
    if (safeName !== name) {
      console.warn(`Secret name '${name}' contains path separators — rejected for safety`);
      return undefined;
    }

    const filePath = path.join(this.directory, safeName);
    try {
      return fs.readFileSync(filePath, "utf-8").trim();
    } catch {
      return undefined;
    }
  }
}

/**
 * Resolves ${secret:NAME} placeholders by querying an ordered list of providers.
 * First provider to return a value wins.
 */
export class SecretResolver {
  private readonly providers: SecretProvider[];

  constructor(providers: SecretProvider[]) {
    this.providers = providers;
  }

  /**
   * Resolve a single secret by name, trying each provider in order.
   */
  resolve(name: string): string | undefined {
    for (const provider of this.providers) {
      const value = provider.resolve(name);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /**
   * Replace all ${secret:NAME} placeholders in a string.
   */
  resolveString(value: string | undefined): string | undefined {
    if (!value) return value;

    const secretPattern = /\$\{secret:([^}]+)\}/g;
    return value.replace(secretPattern, (match, secretName) => {
      const resolved = this.resolve(secretName);
      if (resolved === undefined) {
        console.warn(`Secret '${secretName}' not found in any configured provider`);
        return match;
      }
      return resolved;
    });
  }

  /**
   * Recursively resolve secret placeholders in all string values of an object.
   */
  resolveObject<T extends Record<string, any>>(config: T): T {
    const resolved = { ...config };
    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value === "string") {
        (resolved as any)[key] = this.resolveString(value);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        (resolved as any)[key] = this.resolveObject(value);
      }
    }
    return resolved;
  }

  /**
   * Extract all ${secret:NAME} references from a string.
   */
  static extractSecretNames(value: string): string[] {
    const names: string[] = [];
    const pattern = /\$\{secret:([^}]+)\}/g;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      names.push(match[1]);
    }
    return names;
  }

  /**
   * Check which secret names are resolvable and which are not.
   */
  checkResolvability(names: string[]): { resolved: string[]; unresolved: string[] } {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
      if (this.resolve(name) !== undefined) {
        resolved.push(name);
      } else {
        unresolved.push(name);
      }
    }
    return { resolved, unresolved };
  }

  get providerCount(): number {
    return this.providers.length;
  }

  get providerTypes(): string[] {
    return this.providers.map((p) => p.type);
  }
}

/**
 * Create a SecretResolver from configuration.
 * Defaults to [{ type: "env" }] if no config provided.
 */
export function createSecretResolver(config?: SecretsConfig): SecretResolver {
  const providerConfigs = config?.providers ?? [{ type: "env" }];
  const providers: SecretProvider[] = [];

  for (const pc of providerConfigs) {
    switch (pc.type) {
      case "env":
        providers.push(new EnvProvider());
        break;

      case "dotenv":
        if (!pc.path) {
          console.warn("Dotenv provider requires a 'path' — skipping");
          break;
        }
        providers.push(new DotenvProvider(pc.path));
        break;

      case "file":
        if (!pc.directory) {
          console.warn("File provider requires a 'directory' — skipping");
          break;
        }
        providers.push(new FileProvider(pc.directory));
        break;

      default:
        console.warn(`Unknown secret provider type '${pc.type}' — skipping`);
    }
  }

  // If no providers were successfully created, fall back to env
  if (providers.length === 0) {
    providers.push(new EnvProvider());
  }

  return new SecretResolver(providers);
}

/**
 * Check if a dotenv provider config points to a readable file.
 */
export function validateDotenvPath(filePath: string): { valid: boolean; error?: string } {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return { valid: true };
  } catch {
    return { valid: false, error: `Dotenv file not readable: ${filePath}` };
  }
}

/**
 * Check if a file provider config points to a readable directory.
 */
export function validateFileDirectory(directory: string): { valid: boolean; error?: string } {
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) {
      return { valid: false, error: `Not a directory: ${directory}` };
    }
    fs.accessSync(directory, fs.constants.R_OK);
    return { valid: true };
  } catch {
    return { valid: false, error: `Directory not accessible: ${directory}` };
  }
}
