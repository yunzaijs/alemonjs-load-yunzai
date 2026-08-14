import bodyParser from 'koa-bodyparser';
import multer from '@koa/multer';
import KoaRouter from 'koa-router';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './path';
import {
  backupYunzaiData,
  getDataBackupList,
  getLogViewerData,
  getRepoData,
  getRepositoryArchiveData,
  getStatusData,
  getYunzaiFormData,
  repairRepositoryArchiveSource,
  runYunzaiAction,
  saveRepoData,
  saveYunzaiFormData,
  restoreYunzaiDataBackup,
  unpackRepositoryArchive,
  uploadDataBackup,
  uploadRepositoryArchive,
  uploadYunzaiPluginArchive
} from './panel-service';

const apiRouter = new KoaRouter({
  prefix: '/api'
});
const uploadDir = join(PACKAGE_ROOT, 'runtime', 'uploads');
const PLUGIN_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
const UPLOAD_FILE_TTL_MS = 6 * 60 * 60 * 1000;
const UPLOAD_FILE_LIMIT = 20;

if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}

function cleanupUploadDir(): void {
  const now = Date.now();
  const files = readdirSync(uploadDir)
    .map(name => {
      const filePath = join(uploadDir, name);
      const stat = statSync(filePath);

      return {
        name,
        filePath,
        createdAt: stat.mtimeMs
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const file of files) {
    if (now - file.createdAt > UPLOAD_FILE_TTL_MS) {
      try {
        rmSync(file.filePath, { force: true, recursive: true });
      } catch {}
    }
  }

  while (files.length > UPLOAD_FILE_LIMIT) {
    const oldest = files.shift();

    if (!oldest) {
      break;
    }

    try {
      rmSync(oldest.filePath, { force: true, recursive: true });
    } catch {}
  }
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: PLUGIN_UPLOAD_MAX_BYTES,
    files: 1
  }
});

function runSingleUpload(ctx: { req: unknown; res: unknown; request: { file?: unknown } }): Promise<void> {
  cleanupUploadDir();

  return upload.single('file')(ctx, () => Promise.resolve());
}

apiRouter.use(bodyParser());

apiRouter.get('/repo', ctx => {
  ctx.status = 200;
  ctx.body = {
    code: 200,
    message: 'ok',
    data: getRepoData()
  };
});

apiRouter.post('/repo', ctx => {
  saveRepoData((ctx.request as { body?: Record<string, unknown> }).body ?? {});
  ctx.status = 200;
  ctx.body = {
    code: 200,
    message: '仓库配置保存成功～',
    data: null
  };
});

apiRouter.get('/repo/archives', ctx => {
  ctx.status = 200;
  ctx.body = {
    code: 200,
    message: 'ok',
    data: getRepositoryArchiveData()
  };
});

apiRouter.post('/repo/archive-extract', async ctx => {
  try {
    const target = (ctx.request as { body?: Record<string, unknown> }).body?.target;
    const data = await unpackRepositoryArchive(target as 'yunzai' | 'miao');

    ctx.status = 200;
    ctx.body = { code: 200, message: '压缩包解压完成', data };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, message: err?.message ?? '压缩包解压失败', data: null };
  }
});

apiRouter.post('/repo/archive-repair-origin', async ctx => {
  try {
    const body = (ctx.request as { body?: Record<string, unknown> }).body ?? {};
    const data = await repairRepositoryArchiveSource(body.target as 'yunzai' | 'miao', String(body.repoUrl ?? ''));

    ctx.status = 200;
    ctx.body = { code: 200, message: '仓库来源已修复', data };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, message: err?.message ?? '仓库来源修复失败', data: null };
  }
});

apiRouter.get('/data/backups', ctx => {
  ctx.status = 200;
  ctx.body = { code: 200, message: 'ok', data: getDataBackupList() };
});

apiRouter.post('/data/backup', ctx => {
  try {
    const data = backupYunzaiData();

    ctx.status = 200;
    ctx.body = { code: 200, message: '数据备份已创建', data };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, message: err?.message ?? '数据备份失败', data: null };
  }
});

apiRouter.post('/data/restore', async ctx => {
  try {
    const id = (ctx.request as { body?: Record<string, unknown> }).body?.id;
    const data = await restoreYunzaiDataBackup(String(id ?? ''));

    ctx.status = 200;
    ctx.body = { code: 200, message: '数据备份已恢复', data };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, message: err?.message ?? '数据恢复失败', data: null };
  }
});

apiRouter.get('/yunzai/config', ctx => {
  ctx.status = 200;
  ctx.body = {
    code: 200,
    message: 'ok',
    data: getYunzaiFormData()
  };
});

apiRouter.post('/yunzai/config', ctx => {
  saveYunzaiFormData((ctx.request as { body?: Record<string, unknown> }).body ?? {});
  ctx.status = 200;
  ctx.body = {
    code: 200,
    message: 'Yunzai 配置保存成功～',
    data: null
  };
});

apiRouter.get('/yunzai/status', async ctx => {
  ctx.status = 200;
  ctx.body = {
    code: 200,
    message: 'ok',
    data: await getStatusData()
  };
});

apiRouter.get('/yunzai/logs', ctx => {
  const file = typeof ctx.query.file === 'string' ? ctx.query.file : undefined;
  const lines = typeof ctx.query.lines === 'string' ? Number(ctx.query.lines) || 400 : 400;

  ctx.status = 200;
  ctx.body = {
    code: 200,
    message: 'ok',
    data: getLogViewerData(file, lines)
  };
});

apiRouter.post('/yunzai/action', async ctx => {
  try {
    const data = await runYunzaiAction((ctx.request as { body?: Record<string, unknown> }).body ?? {});

    ctx.status = 200;
    ctx.body = {
      code: 200,
      message: 'ok',
      data
    };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = {
      code: 500,
      message: err?.message ?? '未知错误',
      data: null
    };
  }
});

apiRouter.post('/yunzai/plugin-upload', async ctx => {
  try {
    await runSingleUpload(ctx);
  } catch (err: any) {
    const isFileTooLarge = err?.code === 'LIMIT_FILE_SIZE';

    ctx.status = isFileTooLarge ? 413 : 400;
    ctx.body = {
      code: ctx.status,
      message: isFileTooLarge ? `上传文件过大，当前最大支持 ${Math.floor(PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024)}MB` : (err?.message ?? '上传文件解析失败'),
      data: null
    };

    return;
  }

  const uploadedFile = (ctx.request as { file?: { path: string; originalname?: string; mimetype?: string } }).file;
  const rawDirName = (ctx.request as { body?: Record<string, unknown> }).body?.dirName;
  const dirName = typeof rawDirName === 'string' ? rawDirName : '';

  if (!uploadedFile?.path) {
    ctx.status = 400;
    ctx.body = {
      code: 400,
      message: '缺少上传文件',
      data: null
    };

    return;
  }

  if (!/\.zip$/i.test(uploadedFile.originalname ?? '')) {
    try {
      rmSync(uploadedFile.path, { force: true });
    } catch {}
    ctx.status = 400;
    ctx.body = {
      code: 400,
      message: '仅支持上传 .zip 插件包',
      data: null
    };

    return;
  }

  try {
    const data = await uploadYunzaiPluginArchive(uploadedFile.path, {
      dirName,
      originalName: uploadedFile.originalname
    });

    ctx.status = 200;
    ctx.body = {
      code: 200,
      message: 'ok',
      data
    };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = {
      code: 500,
      message: err?.message ?? '插件上传失败',
      data: null
    };
  } finally {
    try {
      rmSync(uploadedFile.path, { force: true });
    } catch {}
    cleanupUploadDir();
  }
});

apiRouter.post('/repo/archive-upload', async ctx => {
  try {
    await runSingleUpload(ctx);
  } catch (err: any) {
    const isFileTooLarge = err?.code === 'LIMIT_FILE_SIZE';

    ctx.status = isFileTooLarge ? 413 : 400;
    ctx.body = {
      code: ctx.status,
      message: isFileTooLarge ? `上传文件过大，当前最大支持 ${Math.floor(PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024)}MB` : (err?.message ?? '上传文件解析失败'),
      data: null
    };

    return;
  }

  const uploadedFile = (ctx.request as { file?: { path: string; originalname?: string } }).file;
  const target = (ctx.request as { body?: Record<string, unknown> }).body?.target;

  if (!uploadedFile?.path || !uploadedFile.originalname) {
    ctx.status = 400;
    ctx.body = { code: 400, message: '缺少上传文件', data: null };

    return;
  }

  try {
    const data = uploadRepositoryArchive(target as 'yunzai' | 'miao', uploadedFile.path, uploadedFile.originalname);

    ctx.status = 200;
    ctx.body = { code: 200, message: '压缩包已保存；重新上传会覆盖当前压缩包', data };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, message: err?.message ?? '压缩包上传失败', data: null };
  } finally {
    try {
      rmSync(uploadedFile.path, { force: true });
    } catch {}
    cleanupUploadDir();
  }
});

apiRouter.post('/data/backup-upload', async ctx => {
  try {
    await runSingleUpload(ctx);
  } catch (err: any) {
    const isFileTooLarge = err?.code === 'LIMIT_FILE_SIZE';

    ctx.status = isFileTooLarge ? 413 : 400;
    ctx.body = {
      code: ctx.status,
      message: isFileTooLarge ? `上传文件过大，当前最大支持 ${Math.floor(PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024)}MB` : (err?.message ?? '上传文件解析失败'),
      data: null
    };

    return;
  }

  const uploadedFile = (ctx.request as { file?: { path: string; originalname?: string } }).file;

  if (!uploadedFile?.path || !uploadedFile.originalname) {
    ctx.status = 400;
    ctx.body = { code: 400, message: '缺少上传文件', data: null };

    return;
  }

  try {
    const data = uploadDataBackup(uploadedFile.path, uploadedFile.originalname);

    ctx.status = 200;
    ctx.body = { code: 200, message: '数据备份已加入列表', data };
  } catch (err: any) {
    ctx.status = 400;
    ctx.body = { code: 400, message: err?.message ?? '数据备份上传失败', data: null };
  } finally {
    try {
      rmSync(uploadedFile.path, { force: true });
    } catch {}
    cleanupUploadDir();
  }
});

export default apiRouter;
