import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve(process.cwd(), 'node_modules/@alemonjs/onebot/lib/sdk/api.js');
const before = `if (![0, 1].includes(parsedMessage?.retcode)) {\n        reject(parsedMessage?.data);\n        return;\n    }`;
const previousPatch = `if (![0, 1].includes(parsedMessage?.retcode)) {\n        const responseData = parsedMessage?.data;\n        const data = responseData === null || responseData === undefined\n            ? responseData\n            : Array.isArray(responseData)\n                ? { type: 'array', length: responseData.length }\n                : typeof responseData === 'string'\n                    ? { type: 'string', length: responseData.length }\n                    : typeof responseData === 'object'\n                        ? { type: 'object', keys: Object.keys(responseData).sort() }\n                        : { type: typeof responseData };\n        const oneBotResponse = {\n            status: parsedMessage?.status,\n            retcode: parsedMessage?.retcode,\n            wording: parsedMessage?.wording,\n            data\n        };\n        const error = Object.assign(new Error(oneBotResponse.wording || \`[OneBot] action failed (retcode=\${String(oneBotResponse.retcode ?? 'unknown')})\`), { oneBotResponse });\n        reject(error);\n        return;\n    }`;
const after = `if (![0, 1].includes(parsedMessage?.retcode)) {\n        const responseData = parsedMessage?.data;\n        const data = responseData === null || responseData === undefined\n            ? responseData\n            : Array.isArray(responseData)\n                ? { type: 'array', length: responseData.length }\n                : typeof responseData === 'string'\n                    ? { type: 'string', length: responseData.length }\n                    : typeof responseData === 'object'\n                        ? { type: 'object', keys: Object.keys(responseData).sort() }\n                        : { type: typeof responseData };\n        const wording = String(parsedMessage?.wording ?? '').replace(/(uri\\s*=\\s*)(?:base64:\\/\\/)?[A-Za-z0-9+/]{16,}={0,2}/ig, (_match, prefix) => \`\${prefix}<redacted-base64>\`);\n        const oneBotResponse = {\n            status: parsedMessage?.status,\n            retcode: parsedMessage?.retcode,\n            wording,\n            data\n        };\n        const error = Object.assign(new Error(oneBotResponse.wording || \`[OneBot] action failed (retcode=\${String(oneBotResponse.retcode ?? 'unknown')})\`), { oneBotResponse });\n        reject(error);\n        return;\n    }`;

try {
  const source = await readFile(target, 'utf8');

  if (source.includes(after)) {
    console.log('[onebot-diagnostics] already applied');
  } else if (source.includes(before) || source.includes(previousPatch)) {
    await writeFile(target, source.replace(source.includes(previousPatch) ? previousPatch : before, after));
    console.log('[onebot-diagnostics] applied');
  } else {
    console.warn('[onebot-diagnostics] skipped: unsupported @alemonjs/onebot sdk layout');
  }
} catch (error) {
  console.warn(`[onebot-diagnostics] skipped: ${error instanceof Error ? error.message : String(error)}`);
}
