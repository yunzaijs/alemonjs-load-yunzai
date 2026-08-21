//#region \0lvy-asset:13
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/树脂-cneryQ22.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };