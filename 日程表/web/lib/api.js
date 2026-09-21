// 唯一的后端出口：所有请求都打同源 /functions/v1/app，浏览器永远不接触数据库地址或密钥。
// 错误分两类：应用错误码（有中文文案、可判定成败）与结果未知（网络/响应异常，不能重放写请求）。
import { TABLE_NAMES } from './registry.mjs';

export class ApiError extends Error {
  constructor(message, code, { field = null, status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

// 键必须与 functions/handler.mjs 的错误码集合保持一致。
export const MESSAGES = {
  access_denied: '站点访问未获授权，请用你自己的访问入口重新进入',
  network_error: '网络连接中断，数据可能未保存，请检查网络后刷新确认',
  invalid_response: '服务返回了无法识别的内容，请刷新确认结果',
  request_failed: '操作未完成，请重试',
  invalid_input: '填写内容不符合要求，请按提示修改后重试',
  invalid_json: '提交的内容格式有误，请检查后重试',
  invalid_table: '未知的数据类型，请刷新后重试',
  invalid_id: '这条记录标识无效，请刷新后重试',
  invalid_parent: '所属记录不存在或已被删除',
  not_found: '这条记录已不存在，可能被其他设备删除',
  too_large: '提交内容超出长度限制',
  method_not_allowed: '该操作不被支持，请刷新后重试',
  unsupported_media_type: '提交格式不被支持，请刷新后重试',
  table_full: '这一类记录已达上限，请先清理后再添加',
  confirm_required: '需要明确确认后才能执行该操作',
  import_partial: '部分数据未写入，导入未完成，请重新导入',
  database_request_failed: '数据服务暂时不可用，请稍后重试',
  write_result_unknown: '写入结果未知，请刷新确认后再重试',
};

/** 服务端错误文案由本 Function 生成；只接受短文本，避免异常内容直接进入界面。 */
const serverMessage = (value) => (typeof value === 'string' && value.length > 0 && value.length < 200 ? value : null);

export async function requestJson(url, init = {}, { fetchImpl, messages = MESSAGES } = {}) {
  const doFetch = fetchImpl ?? ((input, options) => globalThis.fetch(input, options));
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  let response;
  try {
    response = await doFetch(url, { ...init, headers, credentials: 'same-origin' });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(MESSAGES.network_error, 'network_error');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(MESSAGES.access_denied, 'access_denied', { status: response.status });
  }
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError(MESSAGES.invalid_response, 'invalid_response', { status: response.status });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(MESSAGES.invalid_response, 'invalid_response', { status: response.status });
  }
  const data = body && typeof body === 'object' ? body : null;
  const code = typeof data?.error === 'string' ? data.error
    : (!response.ok || data?.ok === false) && typeof data?.code === 'string' ? data.code
      : response.ok ? null : 'request_failed';
  if (!response.ok || data?.ok === false || code) {
    const resolved = code ?? 'request_failed';
    throw new ApiError(
      serverMessage(data?.message) ?? messages[resolved] ?? MESSAGES.request_failed,
      resolved,
      { field: typeof data?.field === 'string' ? data.field : null, status: response.status },
    );
  }
  if (!data) throw new ApiError(MESSAGES.invalid_response, 'invalid_response', { status: response.status });
  return data;
}

const WRITE_ACTIONS = new Set(['create', 'update', 'remove', 'import', 'wipe']);

/** 响应丢失或后端不可用时无法判定写入是否落库：只能刷新确认，绝不自动重放。 */
export function isWriteOutcomeUnknown(error, action = null) {
  if (!(error instanceof ApiError)) return false;
  if (action && !WRITE_ACTIONS.has(action)) return false;
  return ['network_error', 'invalid_response', 'database_request_failed', 'write_result_unknown'].includes(error.code);
}

function isBootstrapPayload(value) {
  if (!value || typeof value !== 'object' || typeof value.data !== 'object') return false;
  const tables = value.data.tables;
  if (!tables || typeof tables !== 'object') return false;
  return TABLE_NAMES.every((name) => Array.isArray(tables[name]));
}

export function createApi({ baseUrl = '/functions/v1/app', fetchImpl } = {}) {
  const options = { fetchImpl };
  const read = (action) => requestJson(`${baseUrl}?action=${action}`, {}, options);
  const write = (action, payload) => requestJson(`${baseUrl}?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, options);
  return {
    async bootstrap() {
      const result = await read('bootstrap');
      if (!isBootstrapPayload(result)) throw new ApiError(MESSAGES.invalid_response, 'invalid_response');
      return result;
    },
    create: (table, row) => write('create', { table, row }),
    update: (table, id, patch) => write('update', { table, id, patch }),
    remove: (table, id) => write('remove', { table, id }),
    importSnapshot: (tables) => write('import', { tables }),
    wipe: () => write('wipe', { confirm: 'DELETE_ALL' }),
  };
}

export const api = createApi();
