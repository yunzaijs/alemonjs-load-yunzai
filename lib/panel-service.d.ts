type PrimitiveRecord = Record<string, unknown>;
export interface PluginItem {
    name: string;
    installed: boolean;
}
export interface CatalogItem {
    dirName: string;
    label: string;
    aliases: string[];
    repoUrl: string;
    installed: boolean;
}
export declare function getYunzaiFormData(): {
    log_level: {};
    resend: {};
    online_msg: {};
    online_msg_exp: {};
    chromium_path: {};
    puppeteer_ws: {};
    puppeteer_timeout: {};
    proxyAddress: {};
    sign_api_addr: {};
    autoFriend: {};
    autoQuit: {};
    masterQQ: unknown;
    disablePrivate: {};
    disableGuildMsg: {};
    disableMsg: {};
    whiteGroup: unknown;
    whiteQQ: unknown;
    blackGroup: unknown;
    blackQQ: unknown;
    qq: {};
    pwd: {};
    platform: {};
    redis_host: {};
    redis_port: {};
    redis_username: {};
    redis_password: {};
    redis_db: {};
    groupGlobalCD: {};
    singleCD: {};
    onlyReplyAt: {};
    botAlias: unknown;
    imgAddLimit: {};
    imgMaxSize: {};
    addPrivate: {};
    iyuu: {};
    sct: {};
    feishu_webhook: {};
};
export declare function saveYunzaiFormData(db: PrimitiveRecord): void;
export declare function getRepoData(): {
    master_key: any;
    master_id: any;
    gh_proxy: string;
    bot_name: string;
    yunzai_repo: string;
    miao_plugin_repo: string;
    plugins: any;
};
export declare function saveRepoData(db: PrimitiveRecord): void;
export declare function getStatusData(): {
    status: string;
    installed: boolean;
    running: boolean;
    busy: boolean;
    busyTask: string;
    plugins: PluginItem[];
    catalog: CatalogItem[];
    logCount: number;
    help: {
        installFlow: {
            step: string;
            label: string;
            cmd: string;
            desc: string;
        }[];
        controls: {
            cmd: string;
            desc: string;
            color: string;
        }[];
        tools: {
            cmd: string;
            desc: string;
            color: string;
        }[];
    };
};
export declare function runYunzaiAction(data: PrimitiveRecord): Promise<{
    message: string;
}>;
export {};
