import { textTokens, type TextContext } from './view-geometry';

export function refineSourceLocation(text: string, sourceLine: number, sourceColumn: number, word?: string, context?: TextContext) {
  const lines = text.split(/\r?\n/), line = Math.max(0, Math.min(lines.length - 1, sourceLine - 1));
  const fallback = { line, column: Math.max(0, Math.min(sourceColumn, lines[line].length)), length: 0 };
  if (context) {
    const visible = text.replace(/(?<!\\)%[^\r\n]*|\\[a-zA-Z@]+\*?/g, value => ' '.repeat(value.length));
    const tokens = textTokens(visible), candidates: { offset: number; length: number; score: number }[] = [];
    tokens.forEach((token, index) => {
      if (token.word !== context.words[context.index]) return;
      let score = 1;
      for (const direction of [-1, 1]) for (let step = 1; step <= 6; step++) {
        const expected = context.words[context.index + direction * step];
        if (!expected || tokens[index + direction * step]?.word !== expected) break;
        score++;
      }
      candidates.push({ offset: token.offset, length: token.length, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best && (candidates.length === 1 || best.score >= 3 && best.score > candidates[1].score)) {
      const prefix = text.slice(0, best.offset), line = prefix.split(/\r?\n/).length - 1;
      return { line, column: best.offset - prefix.lastIndexOf('\n') - 1, length: best.length };
    }
  }
  word = word?.replaceAll('\u0000', '').trim();
  if (!word || word.length < 2) return fallback;
  const matches = (start: number, end: number) => {
    const result: { line: number; column: number; length: number }[] = [];
    for (let i = start; i <= end; i++) for (let at = lines[i].indexOf(word!); at >= 0; at = lines[i].indexOf(word!, at + 1)) {
      if (/^[\p{L}\p{N}]/u.test(word!) && /[\p{L}\p{N}]$/u.test(lines[i].slice(0, at))) continue;
      if (/[\p{L}\p{N}]$/u.test(word!) && /^[\p{L}\p{N}]/u.test(lines[i].slice(at + word!.length))) continue;
      result.push({ line: i, column: at, length: word!.length });
    }
    return result;
  };
  const nearby = matches(Math.max(0, line - 3), Math.min(lines.length - 1, line + 3));
  nearby.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) || Math.abs(a.column - fallback.column) - Math.abs(b.column - fallback.column));
  if (nearby.length) return nearby[0];
  const global = matches(0, lines.length - 1);
  return global.length === 1 ? global[0] : fallback;
}
