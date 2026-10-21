// LUTviewer is distributed without a paid Apple Developer ID, so give the app an
// ad-hoc signature. Apple Silicon refuses to launch completely unsigned apps.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Universal builds pack each architecture first; only sign the merged app.
  if (/-temp$/.test(context.appOutDir)) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
