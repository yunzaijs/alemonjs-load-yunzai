//#region \0lvy-asset:7
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/sign-DHmxksWD.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };