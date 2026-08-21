//#region \0lvy-asset:15
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/绑定账号-DL2NyycT.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };