import fs from 'node:fs/promises';
import path from 'node:path';

export type QQWebCapabilities = { domains: string[]; csrf: boolean };

/** 只读取源码中的凭据依赖，不导入或改写插件。动态域名仍可经 getCookies 显式查询。 */
export function inspectQQWebCapabilities(source: string): QQWebCapabilities {
  const domains = new Set<string>();
  const patterns = [/\bcookies\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/g, /\b(?:getCookies|getck)\s*\(\s*['"`]([^'"`]*)['"`]/g];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const domain = match[1].toLowerCase();

      if (domain === '' || /^(?:[a-z0-9-]+\.)+qq\.com$/.test(domain) || domain === 'qq.com') {
        domains.add(domain);
      }
    }
  }

  return { domains: [...domains].sort(), csrf: /\b(?:bkn|getCsrfToken)\b/.test(source) };
}

export async function discoverQQWebCapabilities(directory: string): Promise<QQWebCapabilities> {
  const domains = new Set<string>();
  let csrf = false;

  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['node_modules', 'resources', 'data', 'temp'].includes(entry.name)) {
        continue;
      }
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name)) {
        const stat = await fs.stat(file);

        if (stat.size > 2 * 1024 * 1024) {
          continue;
        }
        const capabilities = inspectQQWebCapabilities(await fs.readFile(file, 'utf8'));

        capabilities.domains.forEach(domain => domains.add(domain));
        csrf ||= capabilities.csrf;
      }
    }
  }

  await visit(directory);

  return { domains: [...domains].sort(), csrf };
}
