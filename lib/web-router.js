import { existsSync, readFileSync } from 'fs';
import KoaRouter from 'koa-router';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname$1 = dirname(fileURLToPath(import.meta.url));
function getIndexHtml() {
    const indexPath = join(__dirname$1, '../', 'dist', 'index.html');
    if (!existsSync(indexPath)) {
        return null;
    }
    return readFileSync(indexPath, 'utf-8');
}
async function renderIndex(ctx) {
    const html = getIndexHtml();
    if (!html) {
        ctx.status = 404;
        ctx.body = {
            code: 404,
            message: '前端构建产物不存在，请先构建 frontend/dist。',
            data: null
        };
        return;
    }
    ctx.status = 200;
    ctx.type = 'text/html; charset=utf-8';
    ctx.body = html;
}
const webRouter = new KoaRouter();
webRouter.get('/', renderIndex);
webRouter.get('/manage', renderIndex);
webRouter.get('/plugin', renderIndex);
webRouter.get('/repo/:section(auth|gitrepo|network|plugins)', renderIndex);
webRouter.get('/config/:section(qq|feature|runtime|group|redis|blacklist|notice)', renderIndex);

export { webRouter as default };
