import { UI_ICONS } from "../../assets/img/index.js";
import HTML from "./HTML.js";
import React from "react";

//#region src/img/views/PluginHelp.tsx
/** 从 repoUrl 提取平台标签 */
function getPlatformTag(url) {
	if (url.includes("github.com")) return {
		label: "GitHub",
		color: "text-[#333] bg-[#f0f0f0]"
	};
	if (url.includes("gitee.com")) return {
		label: "Gitee",
		color: "text-[#c71d23] bg-[#fef0f0]"
	};
	if (url.includes("cnb.cool")) return {
		label: "CNB",
		color: "text-[#1a7f37] bg-[#e6f9ed]"
	};
	return {
		label: "Git",
		color: "text-[#666] bg-[#f5f5f5]"
	};
}
function PluginHelp({ data }) {
	const { plugins } = data;
	const installed = [];
	const notInstalled = [];
	for (const p of plugins) (p.installed ? installed : notInstalled).push(p);
	return /* @__PURE__ */ React.createElement(HTML, { style: { width: "780px" } }, /* @__PURE__ */ React.createElement("div", { className: "p-[15px] bg-yz-bg font-['tttgbnumber',system-ui,sans-serif] text-base text-yz-text" }, /* @__PURE__ */ React.createElement("div", {
		className: "rounded-xl py-3.5 px-5 mb-3.5 shadow-card flex items-center justify-between",
		style: { background: "linear-gradient(135deg, #b8e6c8, #7cc99a)" }
	}, /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-2" }, /* @__PURE__ */ React.createElement("img", {
		src: UI_ICONS.paimon,
		className: "w-7 h-7"
	}), /* @__PURE__ */ React.createElement("span", { className: "text-[22px] font-bold text-[#2a5e3a]" }, "Yunzai · 插件列表")), /* @__PURE__ */ React.createElement("div", { className: "flex gap-3 text-[13px]" }, /* @__PURE__ */ React.createElement("span", { className: "text-[#2a7a3a] font-bold" }, "✅ ", installed.length), /* @__PURE__ */ React.createElement("span", { className: "text-[#888]" }, "📦 ", notInstalled.length))), installed.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "bg-yz-card rounded-xl p-4 mb-3.5 shadow-card" }, /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-2 mb-2.5" }, /* @__PURE__ */ React.createElement("div", { className: "w-[5px] h-5 rounded-sm bg-yz-green" }), /* @__PURE__ */ React.createElement("span", { className: "text-base font-bold text-yz-text" }, "已安装"), /* @__PURE__ */ React.createElement("span", { className: "text-[11px] text-yz-gray ml-1" }, "(", installed.length, ")")), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-2 gap-2" }, installed.map((p, i) => {
		const tag = getPlatformTag(p.repoUrl);
		return /* @__PURE__ */ React.createElement("div", {
			key: i,
			className: "bg-yz-green-bg rounded-lg py-2 px-3 border-l-4 border-yz-green"
		}, /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-1.5" }, /* @__PURE__ */ React.createElement("span", { className: "text-[12px] font-bold text-yz-green" }, "✅"), /* @__PURE__ */ React.createElement("span", { className: "text-[12px] font-bold text-yz-text truncate" }, p.label), /* @__PURE__ */ React.createElement("span", { className: "text-[9px] rounded px-1 py-0.5 ml-auto shrink-0 " + tag.color }, tag.label)), /* @__PURE__ */ React.createElement("div", { className: "text-[10px] text-yz-sub mt-0.5 truncate" }, p.dirName), /* @__PURE__ */ React.createElement("div", { className: "text-[11px] text-yz-gray truncate mt-0.5" }, "别名: " + p.aliases.join(" / ")), /* @__PURE__ */ React.createElement("div", { className: "flex gap-1.5 mt-1 flex-wrap" }, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-yz-green bg-white rounded px-1 py-0.5" }, "#yz插件说明" + p.aliases[0]), /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-yz-blue bg-white rounded px-1 py-0.5" }, "#yz更新插件" + p.aliases[0]), /* @__PURE__ */ React.createElement("span", { className: "text-[10px] text-yz-red bg-white rounded px-1 py-0.5" }, "#yz卸载插件" + p.aliases[0])));
	}))), notInstalled.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "bg-yz-card rounded-xl p-4 mb-3.5 shadow-card" }, /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-2 mb-2.5" }, /* @__PURE__ */ React.createElement("div", { className: "w-[5px] h-5 rounded-sm bg-yz-blue" }), /* @__PURE__ */ React.createElement("span", { className: "text-base font-bold text-yz-text" }, "未安装"), /* @__PURE__ */ React.createElement("span", { className: "text-[11px] text-yz-gray ml-1" }, "(", notInstalled.length, ")")), /* @__PURE__ */ React.createElement("div", { className: "grid grid-cols-2 gap-2" }, notInstalled.map((p, i) => {
		const tag = getPlatformTag(p.repoUrl);
		return /* @__PURE__ */ React.createElement("div", {
			key: i,
			className: "bg-yz-blue-bg rounded-lg py-2 px-3"
		}, /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-1.5" }, /* @__PURE__ */ React.createElement("span", { className: "text-[12px] font-bold text-yz-text truncate" }, p.label), /* @__PURE__ */ React.createElement("span", { className: "text-[9px] rounded px-1 py-0.5 ml-auto shrink-0 " + tag.color }, tag.label)), /* @__PURE__ */ React.createElement("div", { className: "text-[10px] text-yz-sub mt-0.5 truncate" }, p.dirName), /* @__PURE__ */ React.createElement("div", { className: "text-[11px] text-yz-gray truncate mt-0.5" }, "别名: " + p.aliases.join(" / ")), /* @__PURE__ */ React.createElement("div", { className: "mt-1" }, /* @__PURE__ */ React.createElement("span", { className: "text-[10px] font-bold text-yz-blue bg-white rounded px-1.5 py-0.5" }, "#yz安装插件" + p.aliases[0])));
	})), /* @__PURE__ */ React.createElement("div", { className: "text-[11px] text-yz-gray mt-2 text-center" }, "支持 #yz安装插件<仓库地址> 直装 · 也可在配置文件中自定义 · 别名不区分大小写")), /* @__PURE__ */ React.createElement("div", { className: "bg-yz-card rounded-xl py-2.5 px-4 shadow-sm flex items-center justify-between" }, /* @__PURE__ */ React.createElement("span", { className: "text-xs text-yz-sub" }, "💡 发送 #yz帮助 查看管理指令"), /* @__PURE__ */ React.createElement("span", { className: "text-xs text-[#b0a18a]" }, "Powered by alemonjs"))));
}

//#endregion
export { PluginHelp as default };