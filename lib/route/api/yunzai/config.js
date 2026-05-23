import { getYunzaiFormData, saveYunzaiFormData } from '../../../panel-service.js';

const GET = async (ctx) => {
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: 'ok',
        data: getYunzaiFormData()
    };
};
const POST = async (ctx) => {
    saveYunzaiFormData(ctx.request.body ?? {});
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: 'Yunzai 配置保存成功～',
        data: null
    };
};

export { GET, POST };
