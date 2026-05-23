import { getRepoData, saveRepoData } from '../../../panel-service.js';

const GET = async (ctx) => {
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: 'ok',
        data: getRepoData()
    };
};
const POST = async (ctx) => {
    saveRepoData(ctx.request.body ?? {});
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: '仓库配置保存成功～',
        data: null
    };
};

export { GET, POST };
