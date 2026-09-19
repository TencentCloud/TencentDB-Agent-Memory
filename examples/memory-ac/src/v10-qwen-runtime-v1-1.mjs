import {spawn} from 'node:child_process';
import {closeSync} from 'node:fs';
import {QwenRuntimeV10 as ParentRuntime} from './v10-qwen-runtime.mjs';
// Windows venv python.exe is a launcher: terminating only its PID leaves the actual Python child alive.
// Preserve v10.0; this revision terminates only the current runtime-owned process tree.
export class QwenRuntimeV10 extends ParentRuntime {
  async stop() {
    const child = this.child; this.child = null; let timer;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        const kill = process.platform === 'win32' ? new Promise((resolve, reject) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
          killer.once('error', reject);
          killer.once('exit', code => code === 0 || child.exitCode !== null || child.signalCode !== null ? resolve() : reject(Error('qwen_tree_termination_failed')));
        }) : (child.kill(), Promise.resolve());
        await Promise.race([Promise.all([exited, kill]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('qwen_tree_termination_timeout')), 5000);
        })]);
      }
    } finally {
      clearTimeout(timer);
      if (this.fd !== undefined) {closeSync(this.fd); this.fd = undefined;}
    }
  }
}
