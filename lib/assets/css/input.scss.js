const reg = ['win32'].includes(process.platform) ? /^file:\/\/\// : /^file:\/\// ;
const fileUrl = new URL('../input.scss-DV20I-W7.css', import.meta.url).href.replace(reg, '');

export { fileUrl as default };
