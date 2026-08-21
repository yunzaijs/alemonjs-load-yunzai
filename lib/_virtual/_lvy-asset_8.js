//#region \0lvy-asset:8
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/七圣召唤-CBycwgMG.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };