import fileUrl from "../../_virtual/_lvy-css_0.js";
import fileUrl$1 from "../../_virtual/_lvy-asset_19.js";
import classNames from "classnames";
import React from "react";

//#region src/img/views/HTML.tsx
const HTML = (props) => {
	const { children, className, ...reSet } = props;
	return /* @__PURE__ */ React.createElement("html", { className: "p-0 m-0" }, /* @__PURE__ */ React.createElement("head", null, /* @__PURE__ */ React.createElement("link", {
		type: "text/css",
		rel: "stylesheet",
		href: fileUrl
	}), /* @__PURE__ */ React.createElement("meta", {
		httpEquiv: "content-type",
		content: "text/html;charset=utf-8"
	}), /* @__PURE__ */ React.createElement("style", { dangerouslySetInnerHTML: { __html: `
              @font-face {
                font-family: 'tttgbnumber';
                src: url('${fileUrl$1}'); 
                font-weight: normal; 
                font-style: normal; 
              }
              body { 
                font-family: 'tttgbnumber', 
                system-ui, sans-serif; 
              }
            ` } })), /* @__PURE__ */ React.createElement("body", {
		className: classNames("p-0 m-0 w-full text-center", className),
		...reSet
	}, children));
};

//#endregion
export { HTML as default };