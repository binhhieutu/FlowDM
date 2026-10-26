const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const ACTIONS = new Set(['none', 'notify', 'sleep', 'shutdown']);
function validateAction(action) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported completion action.');
}

// Fixed script: never interpolate queue names or other external data here.
// https://learn.microsoft.com/dotnet/api/system.windows.forms.application.setsuspendstate
const SUSPEND_SCRIPT = "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)) { throw 'Windows declined the sleep request.' }";

class SystemPowerAdapter {
  constructor({ platform = process.platform, execFile: execute = execFile, notify, env = process.env } = {}) {
    this.platform = platform;
    this.execute = execute;
    this.notify = notify;
    this.systemRoot = env.SystemRoot || env.SYSTEMROOT;
  }

  windowsDirectory() {
    const root = this.systemRoot;
    // Require a local, normalized Windows directory, excluding UNC, relative paths,
    // traversal and command metacharacters. Executables never resolve via PATH/CWD.
    if (typeof root !== 'string' || !/^[a-z]:\\(?:[a-z0-9 _-]+\\)*Windows$/i.test(root)
      || path.win32.normalize(root) !== root) {
      throw new Error('Windows system directory is unavailable or invalid.');
    }
    return path.win32.join(root, 'System32');
  }

  command(action) {
    if (this.platform === 'win32') {
      const system32 = this.windowsDirectory();
      return action === 'shutdown'
        ? [path.win32.join(system32, 'shutdown.exe'), ['/s', '/t', '0']]
        : [path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SUSPEND_SCRIPT]];
    }
    if (this.platform === 'linux') {
      return ['/usr/bin/systemctl', ['--no-ask-password', action === 'shutdown' ? 'poweroff' : 'suspend']];
    }
    if (this.platform === 'darwin') {
      return action === 'sleep' ? ['/usr/bin/pmset', ['sleepnow']]
        : ['/usr/bin/osascript', ['-e', 'tell application "System Events" to shut down']];
    }
    throw new Error(`Power actions are not supported on ${this.platform}.`);
  }

  async perform(action, { queueName = '' } = {}) {
    validateAction(action);
    if (action === 'none') return;
    if (action === 'notify') {
      if (typeof this.notify !== 'function') throw new Error('Desktop notification is unavailable.');
      await this.notify({ title: 'FlowDM', body: `Queue completed: ${queueName}` });
      return;
    }
    const [file, args] = this.command(action);
    await new Promise((resolve, reject) => {
      this.execute(file, args, { shell: false, windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 }, (error) => {
        if (error) reject(new Error(`Unable to ${action}: ${error.message}`));
        else resolve();
      });
    });
  }
}

class PowerActionController extends EventEmitter {
  constructor({ adapter = new SystemPowerAdapter(), monotonicNow = () => performance.now(), countdownMs = 60000,
    beforeDispatch = async () => true } = {}) {
    super();
    if (!Number.isFinite(countdownMs) || countdownMs < 60000) throw new Error('Power countdown must be at least 60 seconds.');
    this.adapter = adapter;
    this.monotonicNow = monotonicNow;
    this.countdownMs = countdownMs;
    this.beforeDispatch = beforeDispatch;
    this.seenIntents = new Set();
    this.epoch = 0;
    this.closed = false;
    this.intent = null;
    this.lastOutcome = null;
    this.status = 'idle';
    this.deadline = null;
    this.timer = null;
    this.dispatchPromise = null;
  }

  snapshot() {
    return {
      status: this.status,
      intentId: this.intent?.intentId ?? null,
      queueId: this.intent?.queueId ?? null,
      queueName: this.intent?.queueName ?? null,
      action: this.intent?.action ?? 'none',
      remainingSeconds: this.status === 'countdown' ? Math.max(0, Math.ceil((this.deadline - this.monotonicNow()) / 1000)) : 0,
      lastOutcome: this.lastOutcome ? { ...this.lastOutcome } : null,
    };
  }

  publish() {
    this.emit('state', this.snapshot());
    this.emit('change', this.snapshot());
    return this.snapshot();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  arm({ intentId, queueId, queueName = '', action } = {}) {
    validateAction(action);
    if (typeof intentId !== 'string' || !intentId || typeof queueId !== 'string' || !queueId
      || typeof queueName !== 'string') throw new Error('Invalid power completion intent.');
    if (this.closed) throw new Error('Power controller is closed.');
    if (this.seenIntents.has(intentId)) return this.snapshot();
    this.cancel('replaced');
    this.seenIntents.add(intentId);
    this.intent = { intentId, queueId, queueName, action };
    this.status = action === 'none' ? 'completed' : 'countdown';
    this.deadline = this.monotonicNow() + (action === 'notify' ? 0 : this.countdownMs);
    if (action === 'none') this.lastOutcome = { status: 'completed', ...this.intent };
    else {
      this.timer = setInterval(() => { void this.tick(); }, 250);
      this.timer.unref?.();
      if (action === 'notify') queueMicrotask(() => { void this.tick(); });
    }
    return this.publish();
  }

  cancel(reason = 'cancelled') {
    this.epoch += 1;
    this.stopTimer();
    if (this.status === 'countdown' || this.status === 'dispatching') {
      this.status = 'cancelled';
      this.lastOutcome = { status: 'cancelled', ...this.intent, reason: String(reason) };
      return this.publish();
    }
    return this.snapshot();
  }

  async tick() {
    if (this.status === 'dispatching') return this.dispatchPromise;
    if (this.status !== 'countdown') return this.snapshot();
    if (this.monotonicNow() < this.deadline) return this.publish();
    const epoch = this.epoch;
    const intent = { ...this.intent };
    this.status = 'dispatching';
    this.stopTimer();
    this.publish();
    this.dispatchPromise = this.dispatch(intent, epoch);
    return this.dispatchPromise;
  }

  async dispatch(intent, epoch) {
    try {
      const allowed = await this.beforeDispatch({ ...intent });
      if (epoch !== this.epoch) return this.snapshot();
      if (allowed !== true) return this.cancel('final-validation-rejected');
      await this.adapter.perform(intent.action, { queueName: intent.queueName });
      if (epoch !== this.epoch) return this.snapshot();
      this.status = 'completed';
      this.lastOutcome = { status: 'completed', ...intent };
    } catch (error) {
      if (epoch !== this.epoch) return this.snapshot();
      this.status = 'failed';
      this.lastOutcome = { status: 'failed', ...intent, error: error?.message || String(error) };
    }
    return this.publish();
  }

  close() {
    this.closed = true;
    return this.cancel('closed');
  }

  dispose() { return this.close(); }
}

module.exports = { PowerActionController, SystemPowerAdapter };
