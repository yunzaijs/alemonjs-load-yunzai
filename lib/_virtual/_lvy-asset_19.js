//#region \0lvy-asset:19
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/tttgbnumber-BbQ05dtA.ttf", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };