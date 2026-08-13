const path = require("path");
const { execFileSync } = require("child_process");

// electron-builder's `identity: null` (package.json) skips real code
// signing, but on Apple Silicon a completely unsigned .app is reported as
// "damaged and can't be opened" — Gatekeeper requires at least an ad-hoc
// signature to launch at all. `identity: null` alone isn't sufficient;
// this re-signs the packed .app ad-hoc (`codesign --sign -`) after
// electron-builder packs it but before it's placed into the dmg/zip, which
// is the documented insertion point for exactly this fix. No-op on
// Windows — signing only exists as a macOS concept.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
