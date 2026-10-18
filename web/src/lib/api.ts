import type { DemoUser, Me } from "@/lib/types";

// 子路径部署（/pipewise/）与本地开发（/）都可用：
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");
export const API_BASE = (import.meta.env.VITE_API_BASE || `${BASE}/api/v1`).replace(/\/+$/, "");

const TOKEN_KEY = "pipewise.token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  code: string;
  details: Record<string, unknown>;
  status: number;
  constructor(code: string, message: string, details: Record<string, unknown> = {}, status = 0) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}): Promise<T> {
  const token = opts.token === undefined ? getToken() : opts.token;
  const res = await fetch(API_BASE + path, {
    method: opts.method || "GET",
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      // 不能用 Authorization：整站挂在 nginx Basic Auth 后面时那个头归 Basic
      ...(token ? { "X-PipeWise-Token": token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* 空响应 */
  }
  const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
  if (!res.ok || err) {
    throw new ApiError(err?.code || `HTTP_${res.status}`, err?.message || "请求失败", err?.details || {}, res.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>(path, { method: "POST", body, headers }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/** 演示用：公开接口，不需要令牌 */
export async function fetchDemoUsers(): Promise<DemoUser[]> {
  const out = await request<{ items: DemoUser[] }>("/dev/demo-users", { token: null });
  return out.items;
}

export async function fetchMe(): Promise<Me> {
  return request<Me>("/me");
}
