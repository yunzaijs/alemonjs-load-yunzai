//#region \0lvy-css:0
const reg = ["win32"].includes(process.platform) ? /^file:\/\/\// : /^file:\/\//;
const fileUrl = new URL("../assets/input.scss-DOqTGMg4.css", import.meta.url).href.replace(reg, "");

//#endregion
export { fileUrl as default };