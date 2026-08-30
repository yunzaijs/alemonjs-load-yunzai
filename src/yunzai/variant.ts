import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type YunzaiVariant = 'miao' | 'trss' | 'yunzai' | 'unknown';

export type YunzaiPackage = {
  name?: string;
  main?: string;
  imports?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  pureEdition?: boolean;
};

export function readYunzaiPackage(yunzaiDir: string): YunzaiPackage | null {
  try {
    const packagePath = join(yunzaiDir, 'package.json');

    if (!existsSync(packagePath)) { return null; }

    return JSON.parse(readFileSync(packagePath, 'utf8')) as YunzaiPackage;
  } catch {
    return null;
  }
}

export function detectYunzaiVariant(pkg: YunzaiPackage | null): YunzaiVariant {
  const name = String(pkg?.name ?? '').toLowerCase();

  if (name === 'trss-yunzai' || name === 'trss_yunzai') { return 'trss'; }
  // Gitee yoimiya-kokomi/Yunzai-Bot 原版的 package.json.name 是 yunzai。
  if (name === 'yunzai') { return 'yunzai'; }

  if (
    name === 'miao-yunzai' ||
    name === 'miao_yunzai' ||
    typeof pkg?.imports?.['#miao'] === 'string' ||
    typeof pkg?.imports?.['#miao.models'] === 'string' ||
    typeof pkg?.scripts?.ksr === 'string'
  ) {
    return 'miao';
  }

  return 'unknown';
}

export function isMiaoYunzai(pkg: YunzaiPackage | null): boolean {
  return detectYunzaiVariant(pkg) === 'miao';
}

export function isTrssYunzai(pkg: YunzaiPackage | null): boolean {
  return detectYunzaiVariant(pkg) === 'trss';
}

export function isOriginalYunzai(pkg: YunzaiPackage | null): boolean {
  return detectYunzaiVariant(pkg) === 'yunzai';
}
