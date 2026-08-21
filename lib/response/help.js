import MihoyoHelp, { MHY_TOTAL_PAGES } from "../img/views/YZ.js";
import { Format, createEvent, useMessage } from "alemonjs";
import { renderComponentIsHtmlToBuffer } from "jsxp";

//#region src/response/help.ts
var help_default = async (e) => {
	const event = createEvent({
		event: e,
		selects: ["message.create", "private.message.create"]
	});
	const [message] = useMessage(event);
	const pageMatch = e.MessageText.match(/(\d+)/);
	let page = pageMatch ? parseInt(pageMatch[1]) : 1;
	if (page < 1) page = 1;
	if (page > 1) page = 1;
	const img = await renderComponentIsHtmlToBuffer(MihoyoHelp, { data: {
		page,
		totalPages: 1
	} });
	if (typeof img === "boolean") {
		const format = Format.create();
		const md = Format.createMarkdown();
		md.addText("米游社帮助图片加载失败，请稍后重试");
		format.addMarkdown(md);
		message.send({ format });
		return;
	}
	const format = Format.create();
	format.addImage(img);
	message.send({ format });
};

//#endregion
export { help_default as default };