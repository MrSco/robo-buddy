/**
 * Every download link and installer filename on the site is built here.
 *
 * The release assets carry the version in their names, so writing one down anywhere else means it
 * 404s at the next bump -- the guide had `RoboBuddy-Setup.exe`, which has never been the name of
 * a real asset. Bumping `package.json` now moves the whole site at once.
 */
import pkg from "../../../package.json";

const REPO = "https://github.com/MrSco/robo-buddy";

/** The version the site is currently advertising, from the root package.json. */
export const version: string = pkg.version;

export const setupExeName = `RoboBuddy-Setup-${version}.exe`;
export const msiName = `RoboBuddy-${version}.msi`;

export const setupExeUrl = `${REPO}/releases/download/v${version}/${setupExeName}`;
export const msiUrl = `${REPO}/releases/download/v${version}/${msiName}`;

/** Every release, newest first, for anyone after an older build. */
export const allReleasesUrl = `${REPO}/releases`;
