export type ApiError = {
  code: string;
  message: string;
};

export type ApiResponse<T> = {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  traceId: string | null;
};

export type HealthItem = {
  status: "UP" | "DOWN" | "SKIPPED" | "CHECKING" | string;
  detail?: string;
};

export async function getJson<T>(path: string): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" }
  });
  const body = (await response.json()) as ApiResponse<T>;
  if (!response.ok && body.error) {
    return body;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return body;
}
