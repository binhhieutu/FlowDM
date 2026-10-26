const fs = require('node:fs');
const path = require('node:path');

function nativeTarget(root, platform, arch) {
  const layouts = {
    'linux-x64': ['linux', 'linux-unpacked/flowdm', 'linux-unpacked/resources/app.asar'],
    'darwin-x64': ['mac-x64', 'mac/FlowDM.app/Contents/MacOS/FlowDM', 'mac/FlowDM.app/Contents/Resources/app.asar'],
    'darwin-arm64': ['mac-arm64', 'mac-arm64/FlowDM.app/Contents/MacOS/FlowDM', 'mac-arm64/FlowDM.app/Contents/Resources/app.asar']
  };
  const layout = layouts[`${platform}-${arch}`];
  if (!layout) throw Error('Unsupported native platform or architecture');
  const base = fs.realpathSync(root);
  return { target: layout[0], executable: path.join(base, 'dist', layout[1]), archive: path.join(base, 'dist', layout[2]) };
}

function assertNativeArtifact({ root, platform, arch, executable, appPath, version, expectedVersion }) {
  const target = nativeTarget(root, platform, arch);
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.resolve(executable) !== target.executable) throw Error('Use the exact canonical packaged executable for this target');
  for (const filename of [target.executable, target.archive]) {
    if (!fs.statSync(filename).isFile() || fs.realpathSync(filename) !== filename) throw Error('Native artifact must be a canonical regular file');
  }
  if (appPath !== undefined && path.resolve(appPath) !== target.archive) throw Error('Running application ASAR does not match the verified archive');
  if (expectedVersion !== undefined && version !== expectedVersion) throw Error('Running application version does not match the verified version');
  return target;
}
module.exports = { nativeTarget, assertNativeArtifact };
