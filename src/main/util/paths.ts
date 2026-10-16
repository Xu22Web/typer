import { app } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 设置文件路径（userData 目录下）。 */
export function settingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * 更新安装包的落地目录。
 *
 * 放在系统临时目录而不是 userData：卸载/升级流程会清理 `%APPDATA%\Typer`，
 * 而安装包在"启动安装程序之后、安装完成之前"必须一直存在，
 * 否则会被卸载器删掉正在运行的安装程序。
 */
export function updateDownloadDir(): string {
  return join(tmpdir(), 'Typer-update')
}
