export function restoreFrame<T extends { imageId: string; data?: string }>(message: T, previous?: { imageId: string; data?: string }): (T & { data: string }) | undefined {
  const data = message.data ?? (previous?.imageId === message.imageId ? previous.data : undefined);
  return data === undefined ? undefined : { ...message, data };
}
