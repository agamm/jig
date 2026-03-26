/* ================================================================== */
/*  ServiceIcon — data-driven registry for 50+ connections              */
/* ================================================================== */

/* Known icons. For unknown services, renders a colored first-letter circle. */
export const ICON_REGISTRY: Record<string, { viewBox: string; paths: string }> = {
  gmail: {
    viewBox: "0 0 512 512",
    paths: `<path d="M158 391v-142l-82-63V361q0 30 30 30" fill="#4285f4"/><path d="M154 248l102 77l102-77v-98l-102 77l-102-77" fill="#ea4335"/><path d="M354 391v-142l82-63V361q0 30-30 30" fill="#34a853"/><path d="M76 188l82 63v-98l-30-23c-27-21-52 0-52 26" fill="#c5221f"/><path d="M436 188l-82 63v-98l30-23c27-21 52 0 52 26" fill="#fbbc04"/>`,
  },
  calendar: {
    viewBox: "0 0 256 256",
    paths: `<polygon fill="#FFF" points="195.37 60.63 60.63 60.63 60.63 195.37 195.37 195.37"/><polygon fill="#EA4335" points="195.37 256 256 195.37 225.68 190.2 195.37 195.37 189.84 223.1"/><path d="M0,195.37V235.79C0,246.96 9.04,256 20.21,256H60.63l6.23-30.32-6.23-30.32-33.03-5.17Z" fill="#188038"/><path d="M256,60.63V20.21C256,9.04 246.96,0 235.79,0H195.37c-3.69,15.04-5.53,26.1-5.53,33.2s1.84,16.24 5.53,27.44c13.41,3.84 23.52,5.76 30.32,5.76 6.8,0 16.91-1.92 30.32-5.76Z" fill="#1967D2"/><polygon fill="#FBBC04" points="256 60.63 195.37 60.63 195.37 195.37 256 195.37"/><polygon fill="#34A853" points="195.37 195.37 60.63 195.37 60.63 256 195.37 256"/><path d="M195.37,0H20.21C9.04,0 0,9.04 0,20.21V195.37H60.63V60.63H195.37Z" fill="#4285F4"/>`,
  },
  drive: {
    viewBox: "0 0 24 24",
    paths: `<path d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574z" fill="#4285F4"/><path d="M7.25 3.214a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214z" fill="#FBBC04"/><path d="M9.509 15.867l-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z" fill="#34A853"/>`,
  },
  github: {
    viewBox: "0 0 24 24",
    paths: `<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" fill="#888"/>`,
  },
  slack: {
    viewBox: "0 0 512 512",
    paths: `<g stroke-width="78" stroke-linecap="round" fill="none"><path stroke="#36c5f0" d="m110 207h97m0-97h.1v-.1"/><path stroke="#2eb67d" d="m305 110v97m97 0v.1h.1"/><path stroke="#ecb22e" d="m402 305h-97m0 97h-.1v.1"/><path stroke="#e01e5a" d="M110 305h.1v.1m97 0v97"/></g>`,
  },
  ai: {
    viewBox: "0 0 24 24",
    paths: `<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  },
};

/* Aliases: map variant names to registry keys */
export const ICON_ALIASES: Record<string, string> = {
  "google calendar": "calendar", "google drive": "drive", "gdrive": "drive",
  "llm": "ai", "openai": "ai", "anthropic": "ai",
  "notion": "notion", "linear": "linear", "mercury": "mercury",
};

/** Resolve a service name (e.g. "gmail", "Google Calendar", "workspace") to a registry key */
export function resolveServiceKey(name: string): string {
  const s = name.toLowerCase().trim();
  return ICON_ALIASES[s] ?? s;
}

export function ServiceIcon({ name, size = 16 }: { name: string; size?: number }) {
  const key = resolveServiceKey(name);
  const icon = ICON_REGISTRY[key];
  if (icon) {
    return (
      // SAFETY: icon.paths is from the static ICON_REGISTRY constant, never user input
      <svg width={size} height={size} viewBox={icon.viewBox} xmlns="http://www.w3.org/2000/svg" dangerouslySetInnerHTML={{ __html: icon.paths }} />
    );
  }
  // Fallback: colored first-letter circle (works for any future connection)
  const colors = ["#4285F4", "#EA4335", "#34A853", "#FBBC04", "#a78bfa", "#f97316", "#06b6d4", "#ec4899"];
  const color = colors[key.charCodeAt(0) % colors.length];
  return (
    <div className="flex items-center justify-center rounded-full text-[9px] font-bold" style={{ width: size, height: size, backgroundColor: color + "22", color }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
