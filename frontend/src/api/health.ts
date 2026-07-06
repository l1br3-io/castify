export interface HealthResponse {
  status: string;
  version: string;
  uptime_seconds: number;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`health check failed: ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}
