/** One place for the constants the whole app reads. */

/** The Space that runs the pipeline. Overridable with ?space=owner/name. */
export const SPACE_ID = "nakas/stemflipper";

export const DEFAULT_BACKEND = `https://${SPACE_ID.replace("/", "-")}.hf.space`;

/**
 * Hugging Face OAuth client id (a public PKCE app — safe to ship in the bundle).
 * Empty until the app is registered; the sign-in button hides itself when it is empty,
 * so the site works anonymously either way.
 */
export const HF_CLIENT_ID: string = import.meta.env.VITE_HF_CLIENT_ID || "";

export const HF_SCOPES = "openid profile";

/** Server-side limits, mirrored so the browser can refuse a file before uploading it. */
export const LIMITS = {
  maxMinutes: 8, // app.py MAX_AUDIO_MINUTES
  maxBytes: 40 * 1024 * 1024, // demo.launch(max_file_size="40mb")
  extensions: [".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".aiff", ".aif", ".wma", ".mp4", ".mov"],
};

/** app.py WORKDIR_TTL_H — how long a finished bundle stays fetchable on the Space. */
export const BUNDLE_TTL_H = 6;

/**
 * GPU seconds per minute of audio, per preset — mirrors stemflipper/neural.py::GPU_COST.
 * Kept in sync by test/quota.test.ts, which checks the whole table against the Python.
 */
export const GPU_COST: Record<string, number> = { fast: 4.0, balanced: 12.0, best: 18.0 };
export const GPU_FIXED_S = 15.0;
export const GPU_SIX_EXTRA = 4.0;

/** ZeroGPU daily quota per account tier, in seconds. */
export const DAILY_QUOTA_S = { anonymous: 120, free: 300, pro: 2400 };

export type Tier = keyof typeof DAILY_QUOTA_S;
export type Preset = "fast" | "balanced" | "best";
export const PRESETS: Preset[] = ["fast", "balanced", "best"];

/** Sister tools on audiosaw.com, linked when a file is too long or too big. */
export const AUDIOSAW = {
  home: "https://audiosaw.com/",
  trim: "https://audiosaw.com/audio-cutter",
  compress: "https://audiosaw.com/audio-compressor",
  convert: "https://audiosaw.com/tools",
};

export const CANONICAL_URL = "https://audiosaw.com/stemflipper/";
