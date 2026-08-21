//#region \0lvy-asset:3
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/abyss-AQQBUUs3.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };