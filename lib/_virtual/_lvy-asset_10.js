//#region \0lvy-asset:10
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/打卡-Cif-Qb30.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };