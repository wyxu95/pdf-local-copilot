/** Display legacy generated labels in English while keeping stored data intact. */
export function displayHistoryLabel(label: string) {
  const batch = /^接受所选修改 · (\d+) 处$/.exec(label);
  if (batch) return `Accepted Changes · ${batch[1]}`;
  return label.replace(/^接受修改 · /, 'Accepted Change · ');
}
