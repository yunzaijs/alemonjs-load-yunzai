//#region \0lvy-asset:2
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/星辉-D8W-mI1o.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };