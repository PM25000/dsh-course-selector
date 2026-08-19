/**
 * dsh-course-selector — 浙江大学选课助手（P0 骨架）。
 *
 * 宿主半区：本地浏览器提供器（BrowserManager）+ 5 个 browser_* 工具 +
 * `tools/pre-execute` 导航权限门 + 随插件捆绑的 course-planning 技能注册。
 * 客户端半区（lib/client.js）见 src/client。
 * @module dsh-course-selector
 */
import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import { Config, resolveConfig, defaultDataDir, type ResolvedConfig } from './config.ts'
import { BrowserManager } from './browser-manager.ts'
import { registerBrowserTools } from './tools.ts'
import { registerCourseTools } from './tools-course.ts'
import { ZjuJwglxtAdapter } from './adapters/zju-jwglxt.ts'
import { createHostGate, registerPermissionGate } from './permission.ts'
import { attachMirrorEndpoints } from './mirror.ts'
import { RatingClient, readRatingUrl, readRatingDataUrl } from './ratings.ts'
import { COURSE_PLANNING_SKILL } from './skills/course-planning.ts'

export const name = 'dsh-course-selector'
export const inject = ['tools', 'webServer']

export { Config }
export type { Config as CourseSelectorConfig, ResolvedConfig } from './config.ts'
export type { BrowserManager, SnapshotResult, SnapshotItem, InteractiveState } from './browser-manager.ts'

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  fs.mkdirSync(defaultDataDir(), { recursive: true })
  fs.mkdirSync(resolved.snapshotDir, { recursive: true })

  const browser = new BrowserManager(resolved)
  ctx.provide('course.browser', browser)
  ctx.effect(() => () => { void browser.close() }, 'dsh-course-selector: browser lifecycle')

  const adapter = new ZjuJwglxtAdapter(new URL(resolved.targetOrigin).origin)
  const dataDir = defaultDataDir()
  const ratings = new RatingClient(dataDir, resolved.ratingTtlMs)
  const ratingBase = (): string => readRatingUrl(dataDir, resolved.teacherRatingUrl)
  registerBrowserTools(ctx, browser, { ratings, baseUrl: ratingBase })
  registerCourseTools(ctx, browser, adapter, {
    ratings,
    baseUrl: ratingBase,
    dataUrl: () => readRatingDataUrl(dataDir),
    injectPage: resolved.injectRatingsOnPage,
  })

  // The configured course-system origin and the teacher-rating site are allowed
  // by design (no approval prompt on first entry); other public hosts ask.
  const seedHosts = [new URL(resolved.targetOrigin).hostname]
  try { seedHosts.push(new URL(resolved.teacherRatingUrl).hostname) } catch { /* rating URL unparseable; fall through */ }
  const gate = createHostGate(defaultDataDir(), seedHosts)
  ctx.effect(() => registerPermissionGate(ctx, gate), 'dsh-course-selector: permission gate')

  // Mirror endpoints ride the shared webServer (inject) as a fiber effect so
  // they unregister on unload. The service merge lives in @deepseek-ai/
  // dsh-host-webserver type land; bridge it structurally here.
  const webServer = (ctx as unknown as { webServer: { register: (r: unknown) => () => void } }).webServer
  ctx.effect(() => attachMirrorEndpoints(webServer, browser, resolved.targetOrigin, dataDir, resolved.teacherRatingUrl, ratings, resolved.injectRatingsOnPage), 'dsh-course-selector: mirror endpoints')

  const skills = (ctx as unknown as { get?: (name: string) => unknown }).get?.('skills') as
    | { register?: (skill: unknown) => () => void }
    | undefined
  if (skills?.register) {
    ctx.effect(() => skills.register!({ ...COURSE_PLANNING_SKILL, source: 'runtime' }), 'dsh-course-selector: skill registration')
  }

  const logger = ctx.logger?.(name)
  logger?.info(
    'dsh-course-selector loaded: engine=' + resolved.engine +
    ' window=' + resolved.windowVisibility +
    ' target=' + resolved.targetOrigin,
  )
}