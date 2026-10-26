const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PowerActionController, SystemPowerAdapter } = require('../../src/core/power-actions.cjs');

const intent = (intentId = 'done-1', action = 'shutdown') => ({ intentId, queueId: 'q1', queueName: 'Downloads', action });
function fixture(t, options = {}) {
  let now = 100;
  const calls = [];
  const controller = new PowerActionController({ adapter: { perform: async (...args) => calls.push(args) }, monotonicNow: () => now, ...options });
  t.after(() => controller.close());
  return { controller, calls, advance: (milliseconds) => { now += milliseconds; } };
}

test('power waits a full monotonic minute and consumes each intent only once', async (t) => {
  const { controller, calls, advance } = fixture(t);
  assert.equal(controller.arm(intent()).remainingSeconds, 60);
  advance(59999);
  await controller.tick();
  assert.equal(controller.snapshot().remainingSeconds, 1);
  assert.equal(calls.length, 0);
  advance(1);
  await Promise.all([controller.tick(), controller.tick()]);
  assert.equal(calls.length, 1);
  assert.equal(controller.snapshot().status, 'completed');
  controller.arm(intent());
  await controller.tick();
  assert.equal(calls.length, 1);
});

test('new intent replaces the single countdown and snapshots are detached', async (t) => {
  const { controller, calls, advance } = fixture(t);
  const first = controller.arm(intent());
  first.action = 'sleep';
  advance(30000);
  controller.arm(intent('done-2', 'sleep'));
  advance(30000);
  await controller.tick();
  assert.equal(calls.length, 0);
  advance(30000);
  await controller.tick();
  assert.equal(calls[0][0], 'sleep');
});

test('cancellation, close and disposal prevent delayed dispatch', async (t) => {
  for (const cancel of [(c) => c.cancel('new-work'), (c) => c.close(), (c) => c.dispose()]) {
    const { controller, calls, advance } = fixture(t);
    controller.arm(intent());
    cancel(controller);
    advance(60000);
    await controller.tick();
    assert.equal(calls.length, 0);
    assert.equal(controller.snapshot().status, 'cancelled');
  }
});

test('beforeDispatch false, thrown error and adapter rejection never escape tick', async (t) => {
  for (const [beforeDispatch, adapter, status] of [
    [async () => false, undefined, 'cancelled'],
    [async () => { throw new Error('Persistence unavailable'); }, undefined, 'failed'],
    [async () => true, { perform: async () => { throw new Error('Permission denied'); } }, 'failed'],
  ]) {
    const { controller, calls, advance } = fixture(t, { beforeDispatch, ...(adapter ? { adapter } : {}) });
    controller.arm(intent());
    advance(60000);
    await controller.tick();
    assert.equal(controller.snapshot().status, status);
    assert.equal(calls.length, 0);
    if (status === 'failed') assert.ok(controller.snapshot().lastOutcome.error);
  }
});

test('cancel during asynchronous final validation prevents a late OS dispatch', async (t) => {
  let resolve;
  const { controller, calls, advance } = fixture(t, { beforeDispatch: () => new Promise((r) => { resolve = r; }) });
  controller.arm(intent());
  advance(60000);
  const running = controller.tick();
  controller.cancel('new-work');
  resolve(true);
  await running;
  assert.equal(calls.length, 0);
  assert.equal(controller.snapshot().status, 'cancelled');
});

test('notify is immediate, none is inert, invalid actions fail closed', async (t) => {
  const { controller, calls } = fixture(t);
  assert.throws(() => controller.arm(intent('bad', 'hibernate')), /action/i);
  controller.arm(intent('none', 'none'));
  await controller.tick();
  assert.equal(calls.length, 0);
  controller.arm(intent('notify', 'notify'));
  await controller.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'notify');
});

test('a new controller never restores another instance countdown', (t) => {
  fixture(t).controller.arm(intent());
  assert.equal(fixture(t).controller.snapshot().status, 'idle');
});

test('invalid intents and countdown configuration cannot arm power actions', (t) => {
  assert.throws(() => new PowerActionController({ countdownMs: 59999 }), /60 seconds/);
  assert.throws(() => new PowerActionController({ countdownMs: NaN }), /60 seconds/);
  const { controller } = fixture(t);
  assert.throws(() => controller.arm(), /action/i);
  for (const patch of [{ intentId: '' }, { queueId: '' }, { queueName: {} }]) {
    assert.throws(() => controller.arm({ ...intent(), ...patch }), /intent/i);
  }
  controller.close();
  assert.throws(() => controller.arm(intent()), /closed/i);
});

test('automatic notification rejection is recorded without an unhandled rejection', async (t) => {
  const { controller } = fixture(t, { adapter: { perform: async () => { throw new Error('Notifications unavailable'); } } });
  const states = [];
  controller.on('state', (state) => states.push(state.status));
  controller.arm(intent('notify-error', 'notify'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().status, 'failed');
  assert.equal(controller.snapshot().lastOutcome.error, 'Notifications unavailable');
  assert.deepEqual(states, ['countdown', 'dispatching', 'failed']);
});

test('adapter uses fixed absolute commands, no shell, and never interpolates queue names', async () => {
  const cases = [
    ['win32', 'shutdown', 'C:\\Windows\\System32\\shutdown.exe', ['/s', '/t', '0']],
    ['linux', 'shutdown', '/usr/bin/systemctl', ['--no-ask-password', 'poweroff']],
    ['linux', 'sleep', '/usr/bin/systemctl', ['--no-ask-password', 'suspend']],
    ['darwin', 'sleep', '/usr/bin/pmset', ['sleepnow']],
    ['darwin', 'shutdown', '/usr/bin/osascript', ['-e', 'tell application "System Events" to shut down']],
  ];
  for (const [platform, action, executable, argv] of cases) {
    const calls = [];
    const adapter = new SystemPowerAdapter({ platform, env: { SystemRoot: 'C:\\Windows' }, execFile: (file, args, options, callback) => { calls.push({ file, args, options }); callback(null); } });
    await adapter.perform(action, { queueName: '"; shutdown /f; evil' });
    assert.equal(calls[0].file, executable);
    assert.deepEqual(calls[0].args, argv);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
  }
});

test('Windows sleep uses supported .NET suspend API and checks its result', async () => {
  let command;
  const adapter = new SystemPowerAdapter({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, execFile: (...args) => { command = args; args[3](null); } });
  await adapter.perform('sleep');
  assert.equal(command[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(command[1].includes('-NonInteractive'));
  const script = command[1].at(-1);
  assert.match(script, /Application\]::SetSuspendState/);
  assert.match(script, /PowerState\]::Suspend, \$false, \$false/);
  assert.match(script, /throw/);
  assert.doesNotMatch(script, /rundll32|Bypass/);
});

test('adapter rejects unsafe root, unsupported OS/actions and OS errors; notification is injected', async () => {
  const execFile = () => { throw new Error('must not execute'); };
  for (const SystemRoot of ['.', 'Windows', '\\\\server\\Windows', 'C:\\evil\\..\\Windows', 'C:\\Windows;evil']) {
    await assert.rejects(new SystemPowerAdapter({ platform: 'win32', env: { SystemRoot }, execFile }).perform('shutdown'), /Windows.*directory/i);
  }
  await assert.rejects(new SystemPowerAdapter({ platform: 'plan9', execFile }).perform('shutdown'), /supported/i);
  await assert.rejects(new SystemPowerAdapter({ execFile }).perform('hibernate'), /action/i);
  await assert.rejects(new SystemPowerAdapter({ platform: 'linux', execFile: (_f, _a, _o, cb) => cb(new Error('permission denied')) }).perform('sleep'), /permission denied/i);
  const messages = [];
  const adapter = new SystemPowerAdapter({ execFile, notify: async (message) => messages.push(message) });
  await adapter.perform('none');
  await adapter.perform('notify', { queueName: 'Downloads' });
  assert.match(JSON.stringify(messages), /Downloads/);
  await assert.rejects(new SystemPowerAdapter({ execFile }).perform('notify'), /notification/i);
});
