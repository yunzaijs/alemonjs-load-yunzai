//#region \0lvy-asset:18
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/攻略-R2--pcMO.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };