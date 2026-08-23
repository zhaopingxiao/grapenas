# 葡萄云 GrapeNAS 面板
# Windows：双击运行（.pyw 无控制台窗口）；macOS/Linux：python3 panel.pyw
# 点"启动"后台无窗口运行葡萄云，点"停止"停止葡萄云
import os
import platform
import signal
import socket
import subprocess
import sys
import time
import webbrowser
import tkinter as tk

if getattr(sys, 'frozen', False):
    # PyInstaller 打包后：exe 所在目录即项目根目录（放 dist/ 等子目录时回退到父目录）
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
    if not os.path.exists(os.path.join(ROOT, 'server', 'index.js')):
        ROOT = os.path.dirname(ROOT)
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 9643
LOG_FILE = os.path.join(ROOT, 'data', 'grapenas.log')
IS_WINDOWS = platform.system() == 'Windows'
CREATE_NO_WINDOW = 0x08000000  # 仅 Windows 使用
DETACHED_PROCESS = 0x00000008  # 仅 Windows 使用


def port_open():
    """纯 Python 探测端口，不产生任何子进程（无黑窗）"""
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(('127.0.0.1', PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def find_server_pid():
    """查找葡萄云进程 PID（未运行返回 None）。先做纯 Python 端口探测，仅在端口已开时才查 PID"""
    if not port_open():
        return None
    if IS_WINDOWS:
        # Windows：netstat -ano（带 CREATE_NO_WINDOW，无黑窗）
        try:
            out = subprocess.run(
                ['netstat', '-ano'],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=CREATE_NO_WINDOW,
            ).stdout
        except Exception:
            return None
        for line in out.splitlines():
            if (':%d ' % PORT) in line and 'LISTENING' in line:
                parts = line.split()
                try:
                    return int(parts[-1])
                except (IndexError, ValueError):
                    return None
        return None
    else:
        # Unix（macOS/Linux）：lsof 查监听端口所属 PID
        try:
            out = subprocess.run(
                ['lsof', '-iTCP:%d' % PORT, '-sTCP:LISTEN', '-t'],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout
            pids = [int(x) for x in out.split() if x.strip().isdigit()]
            return pids[0] if pids else None
        except Exception:
            return None


def start_server():
    """后台无窗口启动葡萄云，输出追加到 data/grapenas.log"""
    if find_server_pid():
        return False
    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
    log = open(LOG_FILE, 'a', encoding='utf-8', buffering=1)
    kwargs = {}
    if IS_WINDOWS:
        # Windows：无控制台 + 脱离父进程
        kwargs['creationflags'] = CREATE_NO_WINDOW | DETACHED_PROCESS
    else:
        # Unix：自成会话/进程组，便于整组停止
        kwargs['start_new_session'] = True
    subprocess.Popen(
        ['node', os.path.join('server', 'index.js')],
        cwd=ROOT,
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        **kwargs,
    )
    return True


def stop_server():
    """停止葡萄云（Windows：taskkill /T 连同其启动的应用一并停止；Unix：进程组信号）"""
    pid = find_server_pid()
    if pid is None:
        return False
    if IS_WINDOWS:
        subprocess.run(
            ['taskkill', '/pid', str(pid), '/T', '/F'],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
        )
    else:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        time.sleep(1.5)
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
    return True


class Panel:
    BG = '#171226'
    FG = '#e5e0f5'
    ACCENT = '#8b5cf6'

    def __init__(self):
        self.win = tk.Tk()
        self.win.title('葡萄云 GrapeNAS 面板')
        self.win.configure(bg=self.BG)
        self.win.resizable(False, False)
        self.win.geometry('300x250')

        tk.Label(self.win, text='葡萄云', font=('Microsoft YaHei', 18, 'bold'),
                 fg=self.ACCENT, bg=self.BG).pack(pady=(24, 0))
        tk.Label(self.win, text='GrapeNAS', font=('Microsoft YaHei', 9),
                 fg='#a89ecf', bg=self.BG).pack()

        self.status_lbl = tk.Label(self.win, text='检测中…', font=('Microsoft YaHei', 11),
                                   fg='#cfc7ee', bg=self.BG)
        self.status_lbl.pack(pady=(18, 0))

        btns = tk.Frame(self.win, bg=self.BG)
        btns.pack(pady=(18, 0))
        self.btn_start = tk.Button(btns, text='启 动', width=8, font=('Microsoft YaHei', 11),
                                   bg=self.ACCENT, fg='white', activebackground='#6d28d9',
                                   activeforeground='white', relief='flat', cursor='hand2',
                                   command=self.on_start)
        self.btn_start.pack(side='left', padx=6)
        self.btn_stop = tk.Button(btns, text='停 止', width=8, font=('Microsoft YaHei', 11),
                                  bg='#2d1b4e', fg='#f87171', activebackground='#4c1d1d',
                                  activeforeground='#f87171', relief='flat', cursor='hand2',
                                  command=self.on_stop)
        self.btn_stop.pack(side='left', padx=6)

        tk.Button(self.win, text='打开管理页面', font=('Microsoft YaHei', 9),
                  bg=self.BG, fg='#a78bfa', activebackground=self.BG,
                  activeforeground='#8b5cf6', relief='flat', cursor='hand2',
                  command=lambda: webbrowser.open('http://localhost:%d' % PORT)
                  ).pack(pady=(16, 0))

        self.refresh()
        self.win.after(2000, self.poll)

    def refresh(self):
        pid = find_server_pid()
        if pid:
            self.status_lbl.config(text='运行中  PID %d' % pid, fg='#4ade80')
            self.btn_start.config(state='disabled', bg='#2d1b4e')
            self.btn_stop.config(state='normal')
        else:
            self.status_lbl.config(text='未运行', fg='#f87171')
            self.btn_start.config(state='normal', bg=self.ACCENT)
            self.btn_stop.config(state='disabled', bg='#2d1b4e')

    def poll(self):
        self.refresh()
        self.win.after(2000, self.poll)

    def flash(self, msg):
        self.status_lbl.config(text=msg, fg='#facc15')
        self.win.after(1500, self.refresh)

    def on_start(self):
        if start_server():
            self.refresh()
        else:
            self.flash('已在运行')

    def on_stop(self):
        if stop_server():
            self.refresh()
        else:
            self.flash('未在运行')

    def run(self):
        self.win.mainloop()


if __name__ == '__main__':
    Panel().run()
