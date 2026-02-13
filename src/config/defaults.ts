import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves the base directory for Mama's data.
 * Checks MAMA_HOME env var first, then uses platform-specific defaults.
 */
export function getMamaHome(): string {
	const envHome = process.env.MAMA_HOME;
	if (envHome) return envHome;

	const home = homedir();
	const os = platform();

	if (os === 'darwin') {
		return join(home, '.mama');
	}
	// Linux: respect XDG_DATA_HOME if set
	const xdgData = process.env.XDG_DATA_HOME;
	if (xdgData) {
		return join(xdgData, 'mama');
	}
	return join(home, '.mama');
}

/**
 * Returns a default MamaConfig-compatible object (pre-validation).
 * This is used as the base that gets merged with user config.
 */
export function getDefaultConfigPath(): string {
	return join(getMamaHome(), 'config.yaml');
}
