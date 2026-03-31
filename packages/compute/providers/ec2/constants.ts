/**
 * Shared constants for EC2 compute provider modules.
 */

/** Username for SSH connections to EC2 instances */
export const REMOTE_USER = "ubuntu";

/** Home directory for the ubuntu user on EC2 instances */
export const REMOTE_HOME = `/home/${REMOTE_USER}`;

/** Default projects directory on EC2 instances */
export const REMOTE_PROJECTS_DIR = `${REMOTE_HOME}/Projects`;
