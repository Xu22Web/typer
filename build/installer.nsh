# Typer 的 NSIS 卸载增强。
#
# 官方模板（app-builder-lib/templates/nsis/uninstaller.nsh）在 deleteAppDataOnUninstall = true 时
# 会删除 %APPDATA%\<应用名>（Electron 的 userData：settings.json、Cache、Local Storage 等）、
# 安装目录、快捷方式与注册表项 —— 这些都已实测确认。
#
# 但安装程序还会把**自己**复制一份到 %LOCALAPPDATA%\<应用名>-updater\installer.exe
# （见 templates/nsis/include/installer.nsh：`copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"`，
# 用于差量更新），而**卸载模板里没有任何删除该目录的代码**，实测数次卸载中有残留
# （这个副本约 88 MB，属于明显残留）。因此这里在卸载流程里把它一并清掉。
#
# 放在 customUnInstall（卸载段开头）而不是 customUnInstallSection（段尾）：
# 定义 customUnInstallSection 会让安装包额外给卸载程序加一页"组件选择"界面，没有必要。
#
# 只删除与本应用同名的目录，不使用通配符，避免误删其它程序或用户数据。
# 这里同时清掉大写的 ${APP_FILENAME}（当前产品名）与小写的 ${APP_PACKAGE_NAME}（包名），
# 后者是历史版本（productName 为 typer 时）留下的目录名。

!macro customUnInstall
  # Electron 的用户数据始终位于"当前用户"目录下（即使按"为所有用户"安装），
  # 因此与官方模板保持一致：先临时切到 current 上下文，删完再切回去。
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  # 更新缓存目录：安装程序副本（约 88MB）
  RMDir /r "$LOCALAPPDATA\${APP_FILENAME}-updater"
  # 用户数据兜底（正常由 deleteAppDataOnUninstall 删除）
  RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
  # 旧产品名（小写）留下的同名目录，避免升级后残留
  !ifdef APP_PACKAGE_NAME
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
  !endif

  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend
