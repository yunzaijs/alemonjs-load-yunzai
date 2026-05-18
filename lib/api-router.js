import bodyParser from 'koa-bodyparser';
import KoaRouter from 'koa-router';
import { getRepoData, saveRepoData, getYunzaiFormData, saveYunzaiFormData, getStatusData, runYunzaiAction } from './panel-service.js';

const apiRouter = new KoaRouter({
    prefix: '/api'
});
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
    saveRepoData(ctx.request.body ?? {});
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: '仓库配置保存成功～',
        data: null
    };
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
    saveYunzaiFormData(ctx.request.body ?? {});
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: 'Yunzai 配置保存成功～',
        data: null
    };
});
apiRouter.get('/yunzai/status', ctx => {
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: 'ok',
        data: getStatusData()
    };
});
apiRouter.post('/yunzai/action', async (ctx) => {
    try {
        const data = await runYunzaiAction(ctx.request.body ?? {});
        ctx.status = 200;
        ctx.body = {
            code: 200,
            message: 'ok',
            data
        };
    }
    catch (err) {
        ctx.status = 500;
        ctx.body = {
            code: 500,
            message: err?.message ?? '未知错误',
            data: null
        };
    }
});

export { apiRouter as default };
