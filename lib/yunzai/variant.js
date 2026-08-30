import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

//#region src/yunzai/variant.ts
function readYunzaiPackage(yunzaiDir) {
	try {
		const packagePath = join(yunzaiDir, "package.json");
		if (!existsSync(packagePath)) return null;
		return JSON.parse(readFileSync(packagePath, "utf8"));
	} catch {
		return null;
	}
}
function detectYunzaiVariant(pkg) {
	const name = String(pkg?.name ?? "").toLowerCase();
	if (name === "trss-yunzai" || name === "trss_yunzai") return "trss";
	if (name === "yunzai") return "yunzai";
	if (name === "miao-yunzai" || name === "miao_yunzai" || typeof pkg?.imports?.["#miao"] === "string" || typeof pkg?.imports?.["#miao.models"] === "string" || typeof pkg?.scripts?.ksr === "string") return "miao";
	return "unknown";
}
function isMiaoYunzai(pkg) {
	return detectYunzaiVariant(pkg) === "miao";
}
function isTrssYunzai(pkg) {
	return detectYunzaiVariant(pkg) === "trss";
}
function isOriginalYunzai(pkg) {
	return detectYunzaiVariant(pkg) === "yunzai";
}

//#endregion
export { detectYunzaiVariant, isMiaoYunzai, isOriginalYunzai, isTrssYunzai, readYunzaiPackage };