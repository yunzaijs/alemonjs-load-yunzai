//#region \0lvy-asset:14
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/weapon-Ywsgkypf.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };