import { API_CALLBACK_TIMEOUT_MS } from '../config';

/**
 * 回调 we-learning-suite-api 的客户端。
 * 所有调用都以 ticket 作为凭证（X-Quiz-Ticket 头）。
 */

/** API 回调错误：携带 HTTP 状态码（4xx/5xx），区别于网络层错误 */
export class ApiClientError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = 'ApiClientError';
	}
}

async function callApi(fetcher: Fetcher, path: string, ticket: string, method: string, body?: unknown): Promise<unknown> {
	const url = `http://we-learning-suite-api${path}`;
	const res = await fetcher.fetch(url, {
		method,
		headers: {
			'Content-Type': 'application/json',
			'X-Quiz-Ticket': ticket,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(API_CALLBACK_TIMEOUT_MS),
	});

	if (!res.ok) {
		const resBody = await res.text().catch(() => '<unreadable>');
		throw new ApiClientError(`API returned ${res.status} for ${method} ${url}\nResponse body: ${resBody.slice(0, 500)}`, res.status);
	}

	try {
		return await res.json();
	} catch {
		return null;
	}
}

/** 会话失败原因码（与 API Worker 的 FAIL_REASONS 白名单一致） */
export type SessionFailReason = 'CONTENT_BLOCKED' | 'CONTENT_REVIEW_PENDING' | 'CONTENT_SCAN_UNAVAILABLE';

/**
 * 更新 session 状态。
 * ticket 即 session id。
 * reason 仅 status === 'failed' 时可携带（内容审核判定），API 端有白名单校验。
 */
export async function patchSessionStatus(
	fetcher: Fetcher,
	ticket: string,
	status: 'processing' | 'completed' | 'failed',
	reason?: SessionFailReason,
): Promise<void> {
	await callApi(fetcher, `/api/quiz/sessions/${ticket}/status`, ticket, 'PATCH', reason ? { status, reason } : { status });
}

/** 细粒度生成进度（随 renew 上报，写 quiz_sessions.progress 列） */
export interface ProgressPayload {
	phase: 'planning' | 'scanning' | 'generating' | 'uploading';
	/** generating / uploading：已生成题数 */
	done?: number;
	/** generating / uploading：计划总题数 */
	total?: number;
}

/**
 * 续期 ticket：将 expires_at 往后推一个 TTL 周期。
 * 在长时生成任务中定期调用，防止上传时 ticket 已过期。
 * 可选携带进度载荷——API 端容错解析，进度数据问题不影响续期本身。
 */
export async function renewTicket(
	fetcher: Fetcher,
	ticket: string,
	progress?: ProgressPayload,
): Promise<void> {
	await callApi(fetcher, `/api/quiz/sessions/${ticket}/renew`, ticket, 'POST',
		progress ? { progress } : undefined);
}

/**
 * 批量上传题目（上传成功后 API 项目会自动把 session 置为 completed）。
 */
export async function uploadQuestions(
	fetcher: Fetcher,
	ticket: string,
	questions: Array<{ type: string; content: unknown; answer: unknown; tags?: string[] }>,
): Promise<void> {
	await callApi(fetcher, '/api/quiz/questions/batch', ticket, 'POST', { questions });
}
