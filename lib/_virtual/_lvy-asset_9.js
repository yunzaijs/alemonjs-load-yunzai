//#region \0lvy-asset:9
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/原石-BYIARiD3.png", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };