//#region \0lvy-asset:4
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/team-jncIWkkY.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };