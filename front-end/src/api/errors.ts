// Error presentation helpers.
//
// The Task 3 integration routes (adapters / metadata reviews / TTS engines) are
// implemented after the core service. Until the connected server provides them it
// answers 404 "接口不存在" or 405 "不支持的接口或请求方法", and a proxy may answer
// 501. Those are NOT empty results: the UI must say the feature is unavailable
// instead of rendering a fabricated success.
export function isUnavailable(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status);
  if (status === 404 || status === 405 || status === 501) return true;
  const code = String(
    (error as { body?: { error?: { code?: unknown } } } | null)?.body?.error?.code ?? '',
  ).toLowerCase();
  return code === 'not_implemented' || code === 'notimplemented' || code === 'unimplemented';
}

/** Server-provided message when the payload carries one, otherwise the thrown text. */
export function errorMessage(error: unknown, fallback = '操作失败，请重试'): string {
  if (!error) return fallback;
  const body = (error as { body?: { error?: { message?: unknown } } }).body;
  const message = body?.error?.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/**
 * Message for an admin/integration call. A missing route is reported explicitly as
 * 暂不可用 so an unimplemented server surface is never mistaken for "no data".
 */
export function integrationError(label: string, error: unknown): string {
  const detail = errorMessage(error);
  return isUnavailable(error) ? `${label}暂不可用：${detail}` : `${label}失败：${detail}`;
}

/** True when a failure is a transport/offline failure rather than a server answer. */
export function isOffline(error: unknown): boolean {
  return error instanceof TypeError || (error as { name?: string } | null)?.name === 'TypeError';
}
