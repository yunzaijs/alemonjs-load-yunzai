import { UI_ICONS } from "../../assets/img/index.js";
import HTML from "./HTML.js";
import React from "react";
import Markdown from "markdown-to-jsx";

//#region src/img/views/PluginReadme.tsx
const mdOverrides = {
	h1: {
		component: "div",
		props: { className: "text-[16px] font-bold text-yz-gold-dark mt-3 mb-1.5 pb-1 border-b border-[#e0d5c0]" }
	},
	h2: {
		component: "div",
		props: { className: "text-[16px] font-bold text-yz-gold-dark mt-3 mb-1.5 pb-1 border-b border-[#e0d5c0]" }
	},
	h3: {
		component: "div",
		props: { className: "text-[14px] font-bold text-yz-text mt-2 mb-1" }
	},
	h4: {
		component: "div",
		props: { className: "text-[14px] font-bold text-yz-text mt-2 mb-1" }
	},
	h5: {
		component: "div",
		props: { className: "text-[14px] font-bold text-yz-text mt-2 mb-1" }
	},
	h6: {
		component: "div",
		props: { className: "text-[14px] font-bold text-yz-text mt-2 mb-1" }
	},
	p: {
		component: "div",
		props: { className: "text-[12px] text-yz-text leading-[1.8]" }
	},
	hr: {
		component: "div",
		props: { className: "border-t border-[#e0d5c0] my-2" }
	},
	pre: {
		component: "pre",
		props: { className: "bg-[#f5f0e8] rounded-lg px-3 py-2 my-1.5 text-[11px] text-[#5a4a3a] overflow-x-auto whitespace-pre-wrap break-all" }
	},
	code: {
		component: "code",
		props: { className: "bg-[#f5f0e8] rounded px-1 py-0.5 text-[11px] text-[#5a4a3a]" }
	},
	ul: {
		component: "ul",
		props: { className: "text-[12px] text-yz-text leading-[1.8] list-disc pl-5 my-1" }
	},
	ol: {
		component: "ol",
		props: { className: "text-[12px] text-yz-text leading-[1.8] list-decimal pl-5 my-1" }
	},
	li: {
		component: "li",
		props: { className: "my-0.5" }
	},
	a: {
		component: "span",
		props: { className: "text-yz-gold-dark underline" }
	},
	blockquote: {
		component: "div",
		props: { className: "border-l-4 border-[#e0d5c0] pl-3 my-1.5 text-[12px] text-yz-sub italic" }
	},
	table: {
		component: "table",
		props: { className: "text-[12px] text-yz-text border-collapse my-2 w-full" }
	},
	th: {
		component: "th",
		props: { className: "border border-[#e0d5c0] px-2 py-1 bg-[#f5f0e8] font-bold text-left" }
	},
	td: {
		component: "td",
		props: { className: "border border-[#e0d5c0] px-2 py-1" }
	},
	img: {
		component: "span",
		props: { className: "hidden" }
	}
};
function PluginReadme({ data }) {
	return /* @__PURE__ */ React.createElement(HTML, { style: { width: "780px" } }, /* @__PURE__ */ React.createElement("div", { className: "p-[15px] bg-yz-bg font-['tttgbnumber',system-ui,sans-serif] text-base text-yz-text" }, /* @__PURE__ */ React.createElement("div", {
		className: "rounded-xl py-3.5 px-5 mb-3.5 shadow-card flex items-center justify-between",
		style: { background: "linear-gradient(135deg, #e8d5b0, #d3bc8e)" }
	}, /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-2" }, /* @__PURE__ */ React.createElement("img", {
		src: UI_ICONS.paimon,
		className: "w-7 h-7"
	}), /* @__PURE__ */ React.createElement("span", { className: "text-[22px] font-bold text-yz-gold-dark" }, data.label)), /* @__PURE__ */ React.createElement("span", { className: "text-[13px] text-[#6b5838]" }, data.dirName)), /* @__PURE__ */ React.createElement("div", { className: "bg-yz-card rounded-xl p-5 mb-3.5 shadow-card" }, /* @__PURE__ */ React.createElement(Markdown, { options: { overrides: mdOverrides } }, data.content)), /* @__PURE__ */ React.createElement("div", { className: "bg-yz-card rounded-xl py-2.5 px-4 shadow-sm flex items-center justify-between" }, /* @__PURE__ */ React.createElement("span", { className: "text-xs text-yz-sub" }, "💡 发送 #yz插件帮助 查看插件列表"), /* @__PURE__ */ React.createElement("span", { className: "text-xs text-[#b0a18a]" }, "Powered by alemonjs"))));
}

//#endregion
export { PluginReadme as default };