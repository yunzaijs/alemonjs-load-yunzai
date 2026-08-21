//#region \0lvy-asset:0
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/role-BbTPmFQ4.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };