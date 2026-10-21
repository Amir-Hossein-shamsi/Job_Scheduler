export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/backend/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const message = (await response.text()).trim();
    if (response.status === 401 && path !== "auth/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      message || "The request could not be completed.",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const dateTime = (value?: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export function duration(start?: string, end?: string) {
  if (!start) return "—";
  const seconds = Math.max(
    0,
    ((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) /
      1000,
  );
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
