import { execFile } from 'node:child_process';
import path from 'node:path';
import { localEnvironment } from './process';
import type { Location, PagePoint } from './live';
function run(args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => execFile('synctex', args, { cwd, env: localEnvironment(), timeout: 10000, maxBuffer: 1024 * 1024 }, (e, stdout) => e ? reject(new Error(`SyncTeX: ${e.message}`)) : resolve(stdout)));
}
export async function externalPosition(pdf: string, file: string, line: number, cwd: string): Promise<PagePoint> {
  const result = await run(['view', '-i', `${line}:0:${file}`, '-o', pdf], cwd);
  const page = result.match(/^Page:(\d+)/m), x = result.match(/^x:([\d.e+-]+)/m), y = result.match(/^y:([\d.e+-]+)/m);
  if (!page || !x || !y) throw new Error(`找不到 ${path.basename(file)}:${line} 的 PDF 位置。`);
  return { page: Number(page[1]) - 1, x: Number(x[1]), y: Number(y[1]) };
}
export async function externalLocation(pdf: string, page: number, x: number, y: number, cwd: string): Promise<Location> {
  const result = await run(['edit', '-o', `${page + 1}:${x}:${y}:${pdf}`], cwd);
  const file = result.match(/^Input:(.+)/m), line = result.match(/^Line:(\d+)/m);
  if (!file || !line) throw new Error('此 PDF 位置没有源码映射。');
  return { file: path.resolve(cwd, file[1].trim()), line: Number(line[1]), column: -1 };
}
