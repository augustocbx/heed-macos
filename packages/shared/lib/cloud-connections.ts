// Refs #56: configure public Google/Microsoft desktop OAuth application IDs,
// then complete owner-authorized real-account QA before enabling either connector.
// Deliberately fixed off: existing private configuration cannot enable account access.
export const CLOUD_CONNECTIONS_ENABLED = {googleDrive:false,oneDrive:false} as const;
export const CLOUD_CONNECTIONS_PENDING_NOTICE = 'Google Drive and OneDrive are disabled until public desktop OAuth application IDs are configured and real-account validation is completed. Local meetings and pending copies are preserved.';
