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

/**
 * 更新 session 状态。
 * ticket 即 session id。
 */
export async function patchSessionStatus(
	fetcher: Fetcher,
	ticket: string,
	status: 'processing' | 'completed' | 'failed',
): Promise<void> {
	await callApi(fetcher, `/api/quiz/sessions/${ticket}/status`, ticket, 'PATCH', { status });
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
