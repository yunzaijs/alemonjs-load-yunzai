import { UI_ICONS } from '../../assets/img/index.js';
import classNames from 'classnames';
import React from 'react';
import HTML from './HTML.js';

const INSTALL_FLOW = [
    { step: '①', label: '安装Yunzai', cmd: '#yz安装', desc: '克隆 Yunzai 仓库' },
    { step: '②', label: '安装插件', cmd: '#yz安装插件miao', desc: '按需安装游戏插件' },
    { step: '③', label: '安装依赖', cmd: '#yz安装依赖', desc: '统一安装所有依赖' },
    { step: '④', label: '启动', cmd: '#yz启动', desc: '启动 Worker 进程' }
];
const COLOR_CLASSES = {
    green: { text: 'text-yz-green', bg: 'bg-yz-green-bg', border: 'border-yz-green' },
    blue: { text: 'text-yz-blue', bg: 'bg-yz-blue-bg', border: 'border-yz-blue' },
    orange: { text: 'text-yz-orange', bg: 'bg-yz-orange-bg', border: 'border-yz-orange' },
    red: { text: 'text-yz-red', bg: 'bg-yz-red-bg', border: 'border-yz-red' }
};
const CONTROLS = [
    { cmd: '#yz安装', desc: '安装 Yunzai 框架', color: 'green' },
    { cmd: '#yz安装插件', desc: '安装指定插件', color: 'green' },
    { cmd: '#yz安装依赖', desc: '重新安装所有依赖', color: 'blue' },
    { cmd: '#yz安装浏览器', desc: '安装Chrome', color: 'blue' },
    { cmd: '#yz启动', desc: '启动 Worker', color: 'green' },
    { cmd: '#yz停止', desc: '停止 Worker', color: 'orange' },
    { cmd: '#yz重启', desc: '停止后重新启动', color: 'blue' },
    { cmd: '#yz更新', desc: '拉取代码+装依赖+重启', color: 'blue' },
    { cmd: '#yz强制更新', desc: '重置本地+更新+装依赖', color: 'red' },
    { cmd: '#yz更新插件', desc: '更新指定插件', color: 'blue' },
    { cmd: '#yz强制更新插件', desc: '重置+更新指定插件', color: 'red' }
];
const TOOLS = [
    { cmd: '#yz状态', desc: '查看当前运行状态', color: 'orange' },
    { cmd: '#yz取消', desc: '取消正在执行的任务', color: 'orange' },
    { cmd: '#yz插件帮助', desc: '查看插件列表', color: 'green' },
    { cmd: '#yz插件说明', desc: '查看插件 README', color: 'green' },
    { cmd: '#yz日志清理', desc: '清理所有日志文件', color: 'orange' },
    { cmd: '#yz卸载插件', desc: '卸载指定插件', color: 'red' },
    { cmd: '#yz卸载', desc: '停止并删除 Yunzai', color: 'red' },
    { cmd: '#yz帮助', desc: '查看本帮助图', color: 'orange' }
];
const MHY_TOTAL_PAGES = 1;
function Title({ color, children }) {
    return (React.createElement("div", { className: 'flex items-center gap-2 mb-2.5' },
        React.createElement("div", { className: classNames('w-[5px] h-5 rounded-sm', color) }),
        React.createElement("span", { className: 'text-base font-bold text-yz-text' }, children)));
}
function CmdRow({ cmd, desc, color }) {
    const c = COLOR_CLASSES[color];
    return (React.createElement("div", { className: classNames('flex items-center gap-2.5 rounded-lg py-2 px-3 border-l-4', c.bg, c.border) },
        React.createElement("span", { className: classNames('text-[13px] font-bold min-w-[80px]', c.text) }, cmd),
        React.createElement("span", { className: 'text-xs text-yz-sub' }, desc)));
}
function MihoyoHelp({ data: _data }) {
    return (React.createElement(HTML, { style: { width: '780px' } },
        React.createElement("div", { className: "p-[15px] bg-yz-bg font-['tttgbnumber',system-ui,sans-serif] text-base text-yz-text" },
            React.createElement("div", { className: 'rounded-xl py-3.5 px-5 mb-3.5 shadow-card flex items-center justify-between', style: { background: 'linear-gradient(135deg, #e8d5b0, #d3bc8e)' } },
                React.createElement("div", { className: 'flex items-center gap-2' },
                    React.createElement("img", { src: UI_ICONS.paimon, className: 'w-7 h-7' }),
                    React.createElement("span", { className: 'text-[22px] font-bold text-yz-gold-dark' }, "Yunzai \u00B7 \u7BA1\u7406\u5E2E\u52A9")),
                React.createElement("span", { className: 'text-[13px] text-[#6b5838]' }, "\u26A0\uFE0F \u4EC5\u4E3B\u4EBA\u53EF\u7528")),
            React.createElement("div", { className: 'bg-yz-card rounded-xl p-4 mb-3.5 shadow-card' },
                React.createElement(Title, { color: 'bg-yz-gold' }, "\u9996\u6B21\u5B89\u88C5\u6D41\u7A0B"),
                React.createElement("div", { className: 'flex items-stretch' }, INSTALL_FLOW.map((s, i) => (React.createElement(React.Fragment, { key: i },
                    i > 0 && (React.createElement("div", { className: 'flex items-center justify-center w-7 shrink-0' },
                        React.createElement("div", { className: 'w-0 h-0', style: {
                                borderTop: '8px solid transparent',
                                borderBottom: '8px solid transparent',
                                borderLeft: '12px solid #d3bc8e'
                            } }))),
                    React.createElement("div", { className: 'flex-1 bg-[#e8d5b033] border-2 border-[#d3bc8e88] rounded-[10px] py-3 px-2 flex flex-col items-center text-center' },
                        React.createElement("div", { className: 'w-9 h-9 rounded-full flex items-center justify-center mb-2 shadow-sm text-base font-bold text-yz-gold-dark', style: { background: 'linear-gradient(135deg, #e8d5b0, #d3bc8e)' } }, s.step),
                        React.createElement("div", { className: 'text-[13px] font-bold text-yz-gold-dark mb-1' }, s.label),
                        React.createElement("div", { className: 'text-[13px] font-bold text-yz-blue bg-yz-blue-bg rounded px-1.5 py-0.5 mb-1' }, s.cmd),
                        React.createElement("div", { className: 'text-[11px] text-yz-sub' }, s.desc)))))),
                React.createElement("div", { className: 'text-[11px] text-yz-gray mt-2 text-center' }, "\u5B89\u88C5\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u542F\u52A8 \u00B7 \u6B65\u9AA4\u2461\u53EF\u91CD\u590D\u6267\u884C\u5B89\u88C5\u591A\u4E2A\u63D2\u4EF6")),
            React.createElement("div", { className: 'flex gap-3.5 mb-3.5' },
                React.createElement("div", { className: 'flex-1 bg-yz-card rounded-xl p-4 shadow-card' },
                    React.createElement(Title, { color: 'bg-yz-blue' }, "\u8FDB\u7A0B\u63A7\u5236"),
                    React.createElement("div", { className: 'flex flex-col gap-2' }, CONTROLS.map((c, i) => (React.createElement(CmdRow, { key: i, ...c }))))),
                React.createElement("div", { className: 'flex-1 bg-yz-card rounded-xl p-4 shadow-card' },
                    React.createElement(Title, { color: 'bg-yz-orange' }, "\u5DE5\u5177\u6307\u4EE4"),
                    React.createElement("div", { className: 'flex flex-col gap-2' }, TOOLS.map((t, i) => (React.createElement(CmdRow, { key: i, ...t })))))),
            React.createElement("div", { className: 'bg-yz-card rounded-xl py-2.5 px-4 shadow-sm flex items-center justify-between' },
                React.createElement("span", { className: 'text-xs text-yz-sub' }, "\uD83D\uDCA1 \u524D\u7F00\u652F\u6301 # ! / \u00B7 \u53EF\u7528 #yz \u6216 #\u4E91\u5D3D"),
                React.createElement("span", { className: 'text-xs text-[#b0a18a]' }, "Powered by alemonjs")))));
}

export { MHY_TOTAL_PAGES, MihoyoHelp as default };
