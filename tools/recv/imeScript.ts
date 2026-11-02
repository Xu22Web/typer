/**
 * 接收端调 PowerShell 用的内联脚本（切英文直输 + 开 VT + 退出时还原）。
 *
 * 为什么要在接收端切输入法：帧是**逐字符打进这个控制台窗口**的，中文输入法开着时字母键会被
 * 吃成候选上屏，帧内容要么丢、要么变形。主程序（typing-host.ps1）在注入前做同样的事，
 * 这里是它的目标机版本——目标机上没有 Typer，只有这一个脚本。
 *
 * 为什么用 `-EncodedCommand`：脚本里有 C# 源码与引号，拼命令行参数极易被转义打死；
 * 编码后只有一个 base64 参数，且不受执行策略限制（内联命令不是脚本文件）。
 *
 * 全部内容保持 ASCII：产物本身要被逐字符打进目标机，非 ASCII 没有物理键位。
 */

/**
 * 为什么逻辑必须写在 C# 里、而不是在 PowerShell 里直接调这些 P/Invoke：
 * 实测 PS 5.1 反射调用 `GetKeyboardLayout(tid)` 会拿到 0（同一个 tid 在 C# 里调用正常返回
 * 0x08040804），于是“探测永远认为输入法没问题、从不切换”——静默失效且极难排查。
 *
 * 只使用 C# 5 语法（PS 5.1 的 `Add-Type` 就那个编译器）：显式声明、字符串拼接，
 * 不用 `out var` / 字符串插值 / `?.`。
 */
const NATIVE = [
  'using System;using System.Runtime.InteropServices;using System.Threading;',
  'public static class KI{',
  '[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);',
  '[DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint t);',
  '[DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr LoadKeyboardLayoutW(string k,uint f);',
  '[DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool PostMessageW(IntPtr h,int m,IntPtr w,IntPtr l);',
  '[DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);',
  '[DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr h);',
  '[DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr h,IntPtr c);',
  '[DllImport("imm32.dll")] static extern bool ImmGetConversionStatus(IntPtr c,out uint a,out uint b);',
  '[DllImport("imm32.dll")] static extern bool ImmSetConversionStatus(IntPtr c,uint a,uint b);',
  '[DllImport("imm32.dll")] static extern bool ImmGetOpenStatus(IntPtr c);',
  '[DllImport("imm32.dll")] static extern bool ImmSetOpenStatus(IntPtr c,bool o);',
  '[DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);',
  '[DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h,out uint m);',
  '[DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h,uint m);',
  '[DllImport("kernel32.dll")] static extern bool SetConsoleOutputCP(uint c);',
  '[DllImport("kernel32.dll")] static extern uint GetConsoleOutputCP();',
  'struct St{public long hkl;public int lang;public int en;public int open;public int nat;public uint conv;public uint sent;}',
  'static St Read(IntPtr h){',
  '  St s=new St();',
  '  if(h==IntPtr.Zero){return s;}',
  '  uint pid=0; uint tid=GetWindowThreadProcessId(h,out pid);',
  '  IntPtr k=GetKeyboardLayout(tid);',
  '  s.hkl=k.ToInt64(); s.lang=(int)(s.hkl&65535); s.en=((s.lang&1023)==9)?1:0;',
  '  IntPtr ic=ImmGetContext(h);',
  '  if(ic!=IntPtr.Zero){',
  '    uint a=0; uint b=0;',
  '    if(ImmGetConversionStatus(ic,out a,out b)){s.conv=a; s.sent=b; s.nat=((a&1)!=0)?1:0;}',
  '    s.open=ImmGetOpenStatus(ic)?1:0;',
  '    ImmReleaseContext(h,ic);',
  '  }',
  '  return s;',
  '}',
  'static string Fmt(St s){return s.hkl+","+s.lang+","+s.en+","+s.open+","+s.nat;}',
  'public static string Init(int ensure){',
  '  int console=0; int vt=0; uint cp=0;',
  '  try{',
  '    IntPtr o=GetStdHandle(-11);',
  '    uint m=0;',
  '    if(o!=IntPtr.Zero && o.ToInt64()!=-1 && GetConsoleMode(o,out m)){',
  '      console=1;',
  '      SetConsoleMode(o,(uint)(m|4));',
  '      uint m2=0;',
  '      if(GetConsoleMode(o,out m2)){vt=(((m2&4))!=0)?1:0;}',
  '    }',
  '    if(console==1){SetConsoleOutputCP(65001); cp=GetConsoleOutputCP();}',
  '  }catch(Exception){}',
  '  IntPtr h=GetForegroundWindow();',
  '  St b=Read(h);',
  '  int sw=0;',
  '  if(ensure==1 && h!=IntPtr.Zero){',
  '    int primary=b.lang&1023;',
  '    if(b.en==0 && (b.nat==1 || b.open==1 || primary==4 || primary==17 || primary==18)){',
  '      IntPtr nk=LoadKeyboardLayoutW("00000409",128);',
  '      if(nk!=IntPtr.Zero){PostMessageW(h,80,IntPtr.Zero,nk); sw=1; Thread.Sleep(60);}',
  '    }',
  '    IntPtr ic=ImmGetContext(h);',
  '    if(ic!=IntPtr.Zero){',
  '      uint a=0; uint bb=0;',
  '      if(ImmGetConversionStatus(ic,out a,out bb)){',
  '        if((a&1)!=0){ImmSetConversionStatus(ic,0,bb); sw=1;}',
  '      }',
  '      if(ImmGetOpenStatus(ic)){ImmSetOpenStatus(ic,false); sw=1;}',
  '      ImmReleaseContext(h,ic);',
  '    }',
  '  }',
  '  St a2=Read(h);',
  '  int ok=((a2.nat==0) && (a2.open==0))?1:0;',
  '  string saved="";',
  '  if(sw==1){saved=h.ToInt64()+","+b.hkl+","+b.open+","+b.conv+","+b.sent;}',
  '  return "ok="+ok+";console="+console+";cp="+cp+";vt="+vt+";switched="+sw+";b="+Fmt(b)+";a="+Fmt(a2)+";s="+saved+";err=";',
  '}',
  'public static string Restore(long hwnd,long hkl,int open,uint conv,uint sent){',
  '  int restored=0; string err="";',
  '  try{',
  '    if(hwnd==0){err="no-state";}',
  '    else{',
  '      IntPtr h=new IntPtr(hwnd);',
  '      if(!IsWindow(h)){err="window-gone";}',
  '      else{',
  '        if(hkl!=0){PostMessageW(h,80,IntPtr.Zero,new IntPtr(hkl)); Thread.Sleep(60);}',
  '        IntPtr ic=ImmGetContext(h);',
  '        if(ic!=IntPtr.Zero){',
  '          ImmSetConversionStatus(ic,conv,sent);',
  '          ImmSetOpenStatus(ic,open!=0);',
  '          ImmReleaseContext(h,ic);',
  '        }',
  '        restored=1;',
  '      }',
  '    }',
  '  }catch(Exception e){err=e.Message.Replace(";",",").Replace("=",":");}',
  '  St a=Read(new IntPtr(hwnd));',
  '  return "ok=1;restored="+restored+";a="+Fmt(a)+";err="+err;',
  '}',
  '}'
].join('\n')

/**
 * @description 拼一段 PowerShell：编译内联 C#，然后调用其中一个静态方法
 * @param call 调用表达式（如 `[KI]::Init(1)`）
 * @returns PowerShell 脚本文本
 */
function wrap(call: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    'try{',
    `Add-Type -TypeDefinition '${NATIVE}' -Language CSharp | Out-Null`,
    `Write-Output (${call})`,
    '}catch{',
    "$m=('' + $_.Exception.Message) -replace '[\\r\\n;]',' '",
    "Write-Output ('ok=0;err=' + $m)",
    '}'
  ].join('\n')
}

/**
 * @description 生成"开控制台 + 切英文直输"的脚本
 * @param ensureIme 是否连输入法一起处理（`--ime off` 时只做控制台初始化）
 * @returns PowerShell 脚本文本
 */
export function consoleInitScript(ensureIme: boolean): string {
  return wrap(`[KI]::Init(${ensureIme ? 1 : 0})`)
}

/**
 * @description 生成"恢复输入法状态"的脚本
 * @param saved 切换前保存的状态
 * @returns PowerShell 脚本文本
 */
export function consoleRestoreScript(saved: {
  hwnd: number
  hkl: number
  open: boolean
  conv: number
  sent: number
}): string {
  const hwnd = Math.trunc(saved.hwnd)
  const hkl = Math.trunc(saved.hkl)
  const open = saved.open ? 1 : 0
  const conv = Math.trunc(saved.conv)
  const sent = Math.trunc(saved.sent)
  return wrap(`[KI]::Restore(${hwnd},${hkl},${open},${conv},${sent})`)
}
