// 把示例应用打包成 .tar（葡萄云「应用」页拖入即可安装）
//
//   node pack.mjs                       -> sample-app/dist/nocode-demo.tar
//   node pack.mjs 输出路径.tar
//
// 打包内容 = nocode-demo/ 目录下的所有文件（条目名不带 ./ 前缀，
// 葡萄云安装时按 tar 根目录读取 config.json）。
// 输出默认落在 dist/（.gitignore 已忽略），避免二进制包混进仓库。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'nocode-demo');
const outTar = path.resolve(process.argv[2] || path.join(here, 'dist', 'nocode-demo.tar'));

if (!fs.existsSync(path.join(srcDir, 'config.json'))) {
  console.error(`找不到示例应用目录: ${srcDir}`);
  process.exit(1);
}

// 目录内容作为 tar 根（跳过 node_modules 与已有 tar）
const entries = fs.readdirSync(srcDir).filter((n) => n !== 'node_modules' && !n.endsWith('.tar'));
fs.rmSync(outTar, { force: true });
fs.mkdirSync(path.dirname(outTar), { recursive: true });
execFileSync('tar', ['-cf', outTar, '-C', srcDir, ...entries], { stdio: 'inherit' });

const list = execFileSync('tar', ['-tf', outTar], { encoding: 'utf8' }).trim().split(/\r?\n/);
console.log(`\n已生成: ${outTar} (${(fs.statSync(outTar).size / 1024).toFixed(1)} KB)`);
console.log('包内条目:');
for (const line of list) console.log('  ' + line);
if (!list.includes('config.json') || !list.includes('main.js')) {
  console.error('\n警告：tar 根下缺少 config.json 或 main.js，葡萄云会拒绝安装');
  process.exit(1);
}
