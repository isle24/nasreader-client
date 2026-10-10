// Account management: admin member rows plus the signed-in user's own account.
//
// The server owns the real rules (uniqueness, 409/400 messages, session
// invalidation); these helpers only mirror the input validation so the form can
// answer before a round trip, build the minimal PUT body, and turn the server's
// status codes into the copy the panel shows inline.
import {errorMessage} from './errors';

export interface UserRow {
  id: number;
  username: string;
  role: string;
  created_at?: number;
}

export type AccountRole = 'admin' | 'member';

export interface MemberUpdate {
  username?: string;
  role?: AccountRole;
  password?: string;
}

export interface MeUpdate {
  username?: string;
  password?: string;
  current_password?: string;
}

/** The slice of ApiClient these helpers need; ApiClient satisfies it structurally. */
export interface AccountClient {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  delete<T = any>(path: string): Promise<T>;
}

export const USERNAME_MAX = 64;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 1024;

/** Mirrors the server rule: trimmed, 1..64 characters. Returns a message or null. */
export function validateUsername(raw: string): string | null {
  const name = (raw ?? '').trim();
  if (!name) return '用户名不能为空';
  if ([...name].length > USERNAME_MAX) return `用户名不能超过 ${USERNAME_MAX} 个字符`;
  return null;
}

/** Empty is allowed unless `required`; otherwise 10..1024 characters. */
export function validatePassword(raw: string, required = false): string | null {
  const value = raw ?? '';
  if (!value) return required ? '密码不能为空' : null;
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    return `密码长度须为 ${PASSWORD_MIN}..${PASSWORD_MAX} 个字符`;
  }
  return null;
}

/**
 * Body for PUT /users/{id} from the inline row editor. Only fields that actually
 * changed are sent, so saving a row can never silently rewrite the role or the
 * password of somebody else. An unchanged row is reported as an error instead of
 * issuing a pointless request.
 */
export function memberUpdateBody(
  draft: {username: string; role: string; password?: string},
  original?: {username?: string; role?: string},
): {body: MemberUpdate; error: string | null} {
  const username = (draft.username ?? '').trim();
  const nameError = validateUsername(username);
  if (nameError) return {body: {}, error: nameError};
  const password = draft.password ?? '';
  const passwordError = validatePassword(password);
  if (passwordError) return {body: {}, error: passwordError};
  const body: MemberUpdate = {};
  if (username !== (original?.username ?? '').trim()) body.username = username;
  const role = draft.role === 'admin' ? 'admin' : 'member';
  if (role !== (original?.role ?? '')) body.role = role;
  if (password) body.password = password;
  if (Object.keys(body).length === 0) return {body, error: '没有需要保存的修改'};
  return {body, error: null};
}

/**
 * Body for PUT /me. A password change must carry the current password; a rename
 * on its own needs nothing else, and the access token stays valid.
 */
export function meUpdateBody(
  draft: {username?: string; password?: string; currentPassword?: string},
  originalUsername = '',
): {body: MeUpdate; error: string | null} {
  const body: MeUpdate = {};
  const username = (draft.username ?? '').trim();
  if (username && username !== originalUsername.trim()) {
    const nameError = validateUsername(username);
    if (nameError) return {body: {}, error: nameError};
    body.username = username;
  }
  const password = draft.password ?? '';
  if (password) {
    const passwordError = validatePassword(password, true);
    if (passwordError) return {body: {}, error: passwordError};
    if (!draft.currentPassword) return {body: {}, error: '修改密码需要填写当前密码'};
    body.password = password;
    body.current_password = draft.currentPassword;
  }
  if (Object.keys(body).length === 0) return {body, error: '没有需要保存的修改'};
  return {body, error: null};
}

/** Copy for a failed account call: a duplicate name is called out explicitly. */
export function accountError(error: unknown, fallback = '保存失败，请重试'): string {
  const status = Number((error as {status?: unknown} | null)?.status);
  if (status === 409) return errorMessage(error, '用户名已存在，请换一个');
  return errorMessage(error, fallback);
}

export function fetchUsers(api: AccountClient): Promise<{items: UserRow[]; total: number}> {
  return api.get<{items: UserRow[]; total: number}>('/users');
}

export function createUser(api: AccountClient, body: {username: string; password: string; role: AccountRole}): Promise<UserRow> {
  return api.post<UserRow>('/users', body);
}

export function updateUser(api: AccountClient, id: number, body: MemberUpdate): Promise<UserRow> {
  return api.put<UserRow>(`/users/${id}`, body);
}

export function deleteUser(api: AccountClient, id: number): Promise<void> {
  return api.delete<void>(`/users/${id}`);
}

/** Self-service rename and optional password change; keeps the current session. */
export function updateMe(api: AccountClient, body: MeUpdate): Promise<UserRow> {
  return api.put<UserRow>('/me', body);
}
