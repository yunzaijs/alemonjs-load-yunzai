import { runYunzaiAction } from '../../../panel-service.js';

const POST = async (ctx) => {
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
};

export { POST };
