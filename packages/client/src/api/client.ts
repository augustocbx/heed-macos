/**
 * Typed HTTP client. All API calls go through here.
 * Switch backends by setting VITE_API_BASE.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "";

export class ApiError extends Error {
	constructor(message: string, public status?: number) {
		super(message);
		this.name = "ApiError";
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, init);
	if (!res.ok) {
		let msg = `${res.status} ${res.statusText}`;
		try {
			const body = await res.json();
			if (body.error) msg = body.error;
		} catch {}
		throw new ApiError(msg, res.status);
	}
	return res.json() as Promise<T>;
}

export const apiClient = {
	get: <T>(path: string) => request<T>(path),
	post: <T>(path: string, body?: unknown) =>
		request<T>(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
	patch: <T>(path: string, body?: unknown) =>
		request<T>(path, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
	delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
	postForm: <T>(path: string, form: FormData) =>
		request<T>(path, { method: "POST", body: form }),
};

export function buildUrl(path: string): string {
	return `${API_BASE}${path}`;
}
