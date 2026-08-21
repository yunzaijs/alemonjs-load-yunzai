//#region \0lvy-asset:5
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/米游社-BiyV3ayE.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };