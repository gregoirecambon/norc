export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  url: string | null;
}

export async function getVersion(): Promise<VersionInfo> {
  const res = await fetch('/api/version');
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<VersionInfo>;
}
