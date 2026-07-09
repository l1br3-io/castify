import { useQuery } from "@tanstack/react-query";

interface HealthResponse {
  status: string;
  version: string;
  uptime_seconds: number;
}

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`health check failed: ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

export function HomePage() {
  const { data, isLoading, error } = useQuery<HealthResponse>({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">One home for all your cloud media.</h1>
        <p className="mt-2 opacity-70">M0 (Foundation) is the current milestone — provider connections and the unified library arrive in later milestones.</p>
      </div>
      <div className="rounded-lg border border-white/10 bg-[var(--color-castify-surface)] p-4">
        <h2 className="text-sm uppercase tracking-wide opacity-60">Backend health</h2>
        {isLoading ? (
          <p className="mt-2 opacity-60">Checking…</p>
        ) : error ? (
          <p className="mt-2 text-red-400">Backend unreachable. Is the API running on port 3000?</p>
        ) : data ? (
          <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
            <dt className="opacity-60">Status</dt>
            <dd className="col-span-2">{data.status}</dd>
            <dt className="opacity-60">Version</dt>
            <dd className="col-span-2">{data.version}</dd>
            <dt className="opacity-60">Uptime</dt>
            <dd className="col-span-2">{data.uptime_seconds}s</dd>
          </dl>
        ) : null}
      </div>
    </section>
  );
}
