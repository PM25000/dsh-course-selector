/**
 * Plugin configuration (schemastery) and resolved runtime shape.
 * @module dsh-course-selector/config
 */
import path from 'node:path'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Browser channel: 'auto' probes Edge → Chrome → bundled chromium. */
  engine: 'auto' | 'chromium' | 'system-edge'
  /** Window mode: visible (human login) | hidden | headless (CI). */
  windowVisibility: 'visible' | 'hidden' | 'headless'
  /** Allowed course-system origin; first navigation elsewhere asks. */
  targetOrigin: string
  /** Snapshot budget (bytes of main text; items capped separately). */
  snapshotMaxChars: number
  snapshotMaxItems: number
  /** Simple retry policy (normal pace, no抢点). */
  retryMaxAttempts: number
  retryBaseIntervalMs: number
  /** Persisted Chromium profile dir; empty → default under $DSH_HOME. */
  userDataDir: string
  /** Stop the mirror screencast after this many ms without a poll. 0 = keep streaming (default). */
  mirrorIdleStopMs: number
  /** Teacher-rating site (查老师/评分站); its URL changes often, so it is
   *  editable from the panel and persisted at runtime. */
  teacherRatingUrl: string
  /** Rating-cache freshness window; refresh happens automatically after it. */
  ratingTtlMs: number
  /** Inject ⭐ rating badges into the course grid page (Lazuli-style). */
  injectRatingsOnPage: boolean
  verbose: boolean
}

export const Config = z.object({
  engine: z.string().default('auto'),
  windowVisibility: z.string().default('visible'),
  targetOrigin: z.string().default('https://zdbk.zju.edu.cn'),
  snapshotMaxChars: z.number().default(12000),
  ratingTtlMs: z.number().default(7 * 24 * 60 * 60 * 1000),
  injectRatingsOnPage: z.boolean().default(true),
  snapshotMaxItems: z.number().default(60),
  retryMaxAttempts: z.number().default(3),
  retryBaseIntervalMs: z.number().default(5000),
  userDataDir: z.string().default(''),
  mirrorIdleStopMs: z.number().default(0),
  teacherRatingUrl: z.string().default('https://dahua309.uk'),
  verbose: z.boolean().default(false),
})

export interface ResolvedConfig {
  engine: Config['engine']
  windowVisibility: Config['windowVisibility']
  targetOrigin: string
  snapshotMaxChars: number
  snapshotMaxItems: number
  retryMaxAttempts: number
  retryBaseIntervalMs: number
  userDataDir: string
  mirrorIdleStopMs: number
  teacherRatingUrl: string
  ratingTtlMs: number
  injectRatingsOnPage: boolean
  snapshotDir: string
  verbose: boolean
}

/** Default plugin data root under $DSH_HOME (or ~/.dsh). */
export function defaultDataDir(): string {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'data', 'course-selector')
}

const ENGINES = ['auto', 'chromium', 'system-edge'] as const
const VISIBILITIES = ['visible', 'hidden', 'headless'] as const

export function resolveConfig(config: Config): ResolvedConfig {
  const dataDir = defaultDataDir()
  const engine = ENGINES.includes(config.engine as (typeof ENGINES)[number]) ? config.engine as (typeof ENGINES)[number] : 'auto'
  const windowVisibility = VISIBILITIES.includes(config.windowVisibility as (typeof VISIBILITIES)[number])
    ? config.windowVisibility as (typeof VISIBILITIES)[number]
    : 'visible'
  return {
    engine,
    windowVisibility,
    targetOrigin: config.targetOrigin || 'https://zdbk.zju.edu.cn',
    snapshotMaxChars: config.snapshotMaxChars ?? 12000,
    snapshotMaxItems: config.snapshotMaxItems ?? 60,
    retryMaxAttempts: config.retryMaxAttempts ?? 3,
    retryBaseIntervalMs: config.retryBaseIntervalMs ?? 5000,
    mirrorIdleStopMs: config.mirrorIdleStopMs ?? 0,
    teacherRatingUrl: config.teacherRatingUrl && config.teacherRatingUrl !== '' ? config.teacherRatingUrl : 'https://dahua309.uk',
    ratingTtlMs: config.ratingTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    injectRatingsOnPage: config.injectRatingsOnPage ?? true,
    userDataDir: config.userDataDir && config.userDataDir !== '' ? config.userDataDir : path.join(dataDir, 'profile'),
    snapshotDir: path.join(dataDir, 'snapshots'),
    verbose: config.verbose ?? false,
  }
}