// 运行 `npm audit --omit=dev`。除下方已审查并接受的公告外，达到或超过审计等级的安全公告都会导致失败。
// 每条已接受的公告都必须注明受影响的包，并解释它为何不适用于当前项目。
// 安装修复版本后应删除对应条目；如果条目已不再匹配，脚本会发出警告。

import { spawnSync } from "node:child_process";

const auditLevel = "moderate";
const severities = ["info", "low", "moderate", "high", "critical"];

/** @type {Record<string, { package: string; reason: string }>} */
const acceptedAdvisories = {
	"GHSA-86w9-cpqp-85rv": {
		package: "node-forge",
		reason:
			"No fixed node-forge release exists. It is only reachable through @earendil-works/gondolin in the private, " +
			"unpublished gondolin example extension. Gondolin only verifies leaf certificates against its own locally " +
			"generated CA (public exponent 65537), so the low-exponent signature forgery does not apply.",
	},
};

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) {
	throw result.error;
}

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr);
	process.stderr.write(result.stdout);
	console.error("npm audit did not produce a JSON report.");
	process.exit(1);
}

if (report.error) {
	console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
	process.exit(1);
}

const minimumSeverity = severities.indexOf(auditLevel);
const seenAccepted = new Set();
const failures = new Map();

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
	for (const via of vulnerability.via) {
		// 字符串条目指向另一个存在漏洞的包；该包会单独报告。
		if (typeof via === "string") {
			continue;
		}
		const id = via.url?.split("/").pop() ?? String(via.source);
		const accepted = acceptedAdvisories[id];
		if (accepted && accepted.package === via.name) {
			seenAccepted.add(id);
			continue;
		}
		if (severities.indexOf(via.severity) >= minimumSeverity) {
			failures.set(`${id}:${via.name}`, via);
		}
	}
}

for (const id of seenAccepted) {
	console.log(`Accepted ${id} (${acceptedAdvisories[id].package}): ${acceptedAdvisories[id].reason}`);
}

for (const id of Object.keys(acceptedAdvisories)) {
	if (!seenAccepted.has(id)) {
		console.log(`::warning::Accepted advisory ${id} no longer matches; remove it from scripts/npm-audit.mjs.`);
	}
}

if (failures.size > 0) {
	console.error(`\nFound ${failures.size} unaccepted advisories at or above ${auditLevel}:`);
	for (const via of failures.values()) {
		console.error(`- ${via.name} ${via.range} [${via.severity}] ${via.title} ${via.url}`);
	}
	process.exit(1);
}

console.log(`No unaccepted advisories at or above ${auditLevel}.`);
