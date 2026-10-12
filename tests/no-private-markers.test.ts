/**
 * 公开仓库里不许出现本机实际值。
 *
 * 内网地址、主机别名、内部路径、真实域名、凭据只写在私有运维记录里，本仓库一律用占位符。
 * **标记表放在仓库根的 `.private-markers.txt`，它被 gitignore 掉、永不入库**（否则这个文件
 * 自己就是一次泄露）。因为路径是中性的，这个文件里也就不含任何敏感值，可以放心提交。
 *
 * 命中时只报「文件:行号」和第几条标记，**不回显命中内容**——回显等于再泄露一次。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const MARKER_FILE = process.env.PRIVATE_MARKERS_FILE
  ? path.resolve(process.env.PRIVATE_MARKERS_FILE)
  : path.join(REPO_ROOT, ".private-markers.txt");

/** 读标记表；没有就返回空（这个检查是**本机护栏**，别的机器上没有这个文件很正常）。 */
function loadMarkers(): RegExp[] {
  if (!fs.existsSync(MARKER_FILE)) return [];

  const patterns: RegExp[] = [];
  fs.readFileSync(MARKER_FILE, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      try {
        patterns.push(new RegExp(line));
      } catch (error) {
        throw new Error(
          `${MARKER_FILE} 第 ${index + 1} 行不是合法正则（${String(error)}）；注释行要以 # 开头`,
        );
      }
    });
  return patterns;
}

/** git 已跟踪 + 已 add 的文件。untracked 的文件推不上去，不在本次检查范围。 */
function listTrackedFiles(): string[] | null {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

describe("公开仓库不含本机私有标记", () => {
  it("git 跟踪的每个文件都不命中 .private-markers.txt 里的标记", () => {
    const patterns = loadMarkers();
    const tracked = listTrackedFiles();
    if (patterns.length === 0 || tracked === null) {
      // 没标记表或不在 git 仓库里：跳过（不是失败）。
      return;
    }

    const hits: string[] = [];
    for (const name of tracked) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(REPO_ROOT, name), "utf8");
      } catch {
        continue; // 读不了的（权限、二进制）不参与检查
      }
      const lines = text.split("\n");
      for (let number = 0; number < lines.length; number += 1) {
        const hit = patterns.findIndex((pattern) => pattern.test(lines[number]));
        if (hit >= 0) hits.push(`  ${name}:${number + 1}（命中标记 #${hit + 1}）`);
      }
    }

    expect(
      hits,
      "这些行命中了本机私有标记，公开仓库里要换成占位符（标记表：.private-markers.txt）",
    ).toEqual([]);
  });
});
