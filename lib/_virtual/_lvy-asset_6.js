//#region \0lvy-asset:6
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/paimon-OA-vsSmb.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };