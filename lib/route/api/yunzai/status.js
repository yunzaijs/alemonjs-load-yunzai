import { getStatusData } from '../../../panel-service.js';

const GET = async (ctx) => {
    ctx.status = 200;
    ctx.body = {
        code: 200,
        message: 'ok',
        data: getStatusData()
    };
};

export { GET };
