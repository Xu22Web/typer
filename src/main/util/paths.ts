import { app } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * @description 设置文件的完整路径（userData 目录下）
 * @returns 路径
 */
export function settingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * @description 更新安装包的落地目录；放在系统临时目录而不是 userData，因为卸载/升级会清理 `%APPDATA%\Typer`，而安装包必须一直存在到安装完成
 * @returns 下载目录
 */
export function updateDownloadDir(): string {
  return join(tmpdir(), 'Typer-update')
}
